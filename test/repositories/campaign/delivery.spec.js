require('../../connections');
const moment = require('moment');
const Promise = require('bluebird');
const { URL } = require('url');
const jwt = require('jsonwebtoken');
const Repo = require('../../../src/repositories/campaign/delivery');
const CampaignRepo = require('../../../src/repositories/campaign');
const AdvertiserRepo = require('../../../src/repositories/advertiser');
const PlacementRepo = require('../../../src/repositories/placement');
const TemplateRepo = require('../../../src/repositories/template');
const AnalyticsEvent = require('../../../src/models/analytics/event');
const Utils = require('../../../src/utils');
const sandbox = sinon.createSandbox();

const createAdvertiser = async () => {
  const results = await AdvertiserRepo.seed();
  return results.one();
};

const createCampaign = async () => {
  const results = await CampaignRepo.seed();
  return results.one();
};

const createPlacement = async () => {
  const results = await PlacementRepo.seed();
  return results.one();
}

const createTemplate = async () => {
  const results = await TemplateRepo.seed();
  return results.one();
}

const testImageBeacon = (html) => {
  let pattern = /^<div data-fortnight-type="placement"><img data-fortnight-view="pending" data-fortnight-beacon="http:\/\/www\.foo\.com\/e\/[a-zA-Z0-9._-]+\/view.gif" src="http:\/\/www\.foo\.com\/e\/[a-zA-Z0-9._-]+\/load.gif"><\/div>$/;
  expect(html).to.match(pattern);
};

const testContainsImageBeacon = (html) => {
  let pattern = /<div data-fortnight-type="placement"><img data-fortnight-view="pending" data-fortnight-beacon="http:\/\/www\.foo\.com\/e\/[a-zA-Z0-9._-]+\/view.gif" src="http:\/\/www\.foo\.com\/e\/[a-zA-Z0-9._-]+\/load.gif"><\/div>/;
  expect(html).to.match(pattern);
};

describe('repositories/campaign/delivery', function() {
  before(async function() {
    await CampaignRepo.remove();
    await PlacementRepo.remove();
    await TemplateRepo.remove();
  });
  after(async function() {
    await CampaignRepo.remove();
    await PlacementRepo.remove();
    await TemplateRepo.remove();
  });

  describe('#parseOptions', function() {
    [null, undefined, '', 'somestring', 0].forEach((value) => {
      it(`should return an object when the options are '${value}'.`, function(done) {
        expect(Repo.parseOptions(value)).to.be.an('object');
        done();
      });
    });
    it('should parse the options', function(done) {
      expect(Repo.parseOptions('{"foo":"bar"}')).to.deep.equal({ foo: 'bar' });
      done();
    });
  });

  describe('#getPlacementAndTemplate', function() {
    let placement;
    let template;
    before(async function() {
      placement = await createPlacement();
      template = await createTemplate();
    });
    after(async function() {
      await PlacementRepo.remove();
      await TemplateRepo.remove();
    });

    it('should reject when no params are sent', async function() {
      await expect(Repo.getPlacementAndTemplate()).to.be.rejectedWith(Error);
    });
    [null, undefined, ''].forEach((placementId) => {
      it(`should reject when the placementId is '${placementId}'.`, async function() {
        const templateId = template.id;
        await expect(Repo.getPlacementAndTemplate({ templateId })).to.be.rejectedWith(Error, 'No placement ID was provided.');
      });
    });
    [null, undefined, ''].forEach((templateId) => {
      it(`should reject when the templateId is '${templateId}'.`, async function() {
        const placementId = placement.id;
        await expect(Repo.getPlacementAndTemplate({ placementId })).to.be.rejectedWith(Error, 'No template ID was provided.');
      });
    });
    it('should reject when no placement could be found.', async function() {
      const placementId = '507f1f77bcf86cd799439011';
      const templateId = template.id;
      await expect(Repo.getPlacementAndTemplate({ placementId, templateId })).to.be.rejectedWith(Error, `No placement exists for ID '${placementId}'`);
    });
    it('should reject when no template could be found.', async function() {
      const placementId = placement.id;
      const templateId = '507f1f77bcf86cd799439011';
      await expect(Repo.getPlacementAndTemplate({ placementId, templateId })).to.be.rejectedWith(Error, `No template exists for ID '${templateId}'`);
    });
    it('should fulfill with the placement and template.', async function() {
      const placementId = placement.id;
      const templateId = template.id;

      const promise = Repo.getPlacementAndTemplate({ placementId, templateId });
      await expect(promise).to.eventually.be.an('object');
      const result = await promise;
      expect(result.placement.id).to.equal(placementId);
      expect(result.template.id).to.equal(templateId);
    });
  });

  describe('#createRequestEvent', function() {
    it('should create the request event.', function(done) {
      const params = {
        e: 'view',
        uuid: '1234',
        bot: 'foo',
        pid: '5aa03a87be66ee000110c13b',
        cid: '5aabc20d62a17f0001bbcba4',
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3325.162 Safari/537.36',
        kv: {
          foo: 'bar',
        },
      };
      const event = Repo.createRequestEvent(params);
      expect(event).to.be.an.instanceOf(AnalyticsEvent);
      expect(event.e).to.equal('request');
      expect(event.uuid).to.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      expect(event.cid.toString()).to.equal(params.cid);
      expect(event.pid.toString()).to.equal(params.pid);
      expect(event.d).to.be.an.instanceOf(Date);
      expect(event.bot.detected).to.be.false;
      expect(event.ua.ua).to.equal(params.ua);
      expect(event.kv).to.deep.equal(params.kv);
      done();
    });
    it('should set the cid to undefined if not present.', function(done) {
      const params = {
        pid: '5aa03a87be66ee000110c13b',
        cid: '',
      };
      const event = Repo.createRequestEvent(params);
      expect(event.cid).to.be.undefined;
      done();
    });
    it('should set if the ua is a bot.', function(done) {
      const params = {
        pid: '5aa03a87be66ee000110c13b',
        ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      };
      const event = Repo.createRequestEvent(params);
      expect(event.bot.detected).to.be.true;
      expect(event.bot.value).to.equal('googlebot');
      done();
    });
  });

  describe('#queryCampaigns', function() {
    let placement1;
    let placement2;
    before(async function() {
      await AdvertiserRepo.remove();
      await CampaignRepo.remove();
      await PlacementRepo.remove();
      await TemplateRepo.remove();

      const advertiser = await createAdvertiser();

      placement1 = await createPlacement();
      placement2 = await createPlacement();
      const now = new Date();
      const futureEnd = moment().add(1, 'year').toDate();

      const propSet = [
        { status: 'Active', criteria: { placementIds: [placement1.id], start: now, end: futureEnd } },
        { status: 'Active', criteria: { placementIds: [placement2.id], start: now } },
        { status: 'Active', criteria: { placementIds: [placement1.id], start: now, kvs: [ { key: 'sectionId', value: '1234' } ] } },
        { status: 'Draft', criteria: { placementIds: [placement1.id], start: now, kvs: [ { key: 'sectionId', value: '1234' } ] } },
        { status: 'Active', criteria: { placementIds: [placement1.id], start: now, kvs: [ { key: 'sectionId', value: '1234' } ] } },
        { status: 'Active', criteria: { placementIds: [placement2.id], start: now, kvs: [ { key: 'sectionId', value: '1234' } ] } },
        { status: 'Active', criteria: { placementIds: [placement1.id], start: now, kvs: [ { key: 'sectionId', value: '1234' }, { key: 'x', value: '1' } ] } },
      ];
      const promises = Promise.all(propSet.map((props) => {
        const campaign = CampaignRepo.generate(1, {
          advertiserId: () => advertiser.id,
          placementId: () => props.criteria.placementIds[0],
        }).one();
        campaign.set(props);
        return campaign.save();
      }));
      await promises;

    });
    after(async function() {
      await AdvertiserRepo.remove();
      await CampaignRepo.remove();
      await PlacementRepo.remove();
      await TemplateRepo.remove();
    });
    beforeEach(function () {
      sandbox.spy(Utils, 'cleanValues');
    });
    afterEach(function() {
      sinon.assert.calledOnce(Utils.cleanValues);
      sandbox.restore();
    });
    it('should return no campaigns when campaign start date greater than now.', async function() {
      const params = {
        startDate: moment().subtract(1, 'year').toDate(),
        placementId: placement1.id,
        limit: 1,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(0);
    });
    it('should return four campaigns when using placement1 and just start date', async function() {
      const params = {
        startDate: new Date(),
        placementId: placement1.id,
        limit: 100,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(4);
    });
    it('should return three campaigns when using placement1 and current date is outside end date', async function() {
      const params = {
        startDate: moment().add(2, 'year').toDate(),
        placementId: placement1.id,
        limit: 100,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(3);
    });
    it('should return two campaigns when using placement2 and just start date', async function() {
      const params = {
        startDate: new Date(),
        placementId: placement2.id,
        limit: 100,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(2);
    });
    it('should return three campaigns when using placement1 with start date and sectionId kv', async function() {
      const params = {
        startDate: new Date(),
        placementId: placement1.id,
        keyValues: { sectionId: 1234 },
        limit: 100,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(3);
    });
    it('should return one campaigns when using placement1 with start date and sectionId+x kv', async function() {
      const params = {
        startDate: new Date(),
        placementId: placement1.id,
        keyValues: { sectionId: 1234, x: 1 },
        limit: 100,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(1);
    });
    it('should return zero campaigns when using placement1 with start date and sectionId kv with invalid value', async function() {
      const params = {
        startDate: new Date(),
        placementId: placement1.id,
        keyValues: { sectionId: 12345 },
        limit: 100,
      };
      const promise = Repo.queryCampaigns(params);
      await expect(promise).to.eventually.be.an('array');
      const result = await promise;
      expect(result.length).to.equal(0);
    });
  });

  describe('#createCampaignRedirect', function() {
    beforeEach(function() {
      sandbox.spy(jwt, 'sign');
    });
    afterEach(function() {
      sandbox.restore();
    });

    it('should return the redirect URL.', function(done) {
      const requestURL = 'http://foo.com';
      const event = {
        uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        pid: '5aa03a87be66ee000110c13b',
        cid: '5aabc20d62a17f0001bbcba4',
      };
      const url = Repo.createCampaignRedirect(requestURL, event);
      expect(url).to.match(/^http:\/\/foo\.com\/redir\/.*$/);
      sinon.assert.calledOnce(jwt.sign);
      sinon.assert.calledWith(jwt.sign, event, sinon.match.any, { noTimestamp: true });
      done();
    });
  });

  describe('#createFallbackRedirect', function() {
    beforeEach(function() {
      sandbox.spy(jwt, 'sign');
      sandbox.spy(Repo, 'injectUTMParams');
    });
    afterEach(function() {
      sandbox.restore();
    });

    [undefined, '', '/foo/path.jpg', 'www.google.com', null].forEach((value) => {
      it(`should pass the URL back, as-is, when the url value is '${value}'`, function(done) {
        expect(Repo.createFallbackRedirect(value)).to.equal(value);
        sinon.assert.notCalled(jwt.sign);
        done();
      });
    });

    it('should return the fallback redirect URL.', function(done) {
      const url = 'http://www.redirect-to.com';
      const requestURL = 'http://foo.com';
      const event = {
        uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        pid: '5aa03a87be66ee000110c13b',
        cid: '5aabc20d62a17f0001bbcba4',
      };
      const redirect = Repo.createFallbackRedirect(url, requestURL, event);

      expect(redirect).to.match(/^http:\/\/foo\.com\/redir\/.*$/);
      sinon.assert.calledOnce(Repo.injectUTMParams);
      sinon.assert.calledOnce(jwt.sign);
      sinon.assert.calledWith(jwt.sign, Object.assign(event, { url: Repo.injectUTMParams(url, event) }), sinon.match.any, { noTimestamp: true });
      done();
    });

  });

  describe('#fillWithFallbacks', function() {
    it('should leave campaign array untouched when length is >= limit', function(done) {
      const campaigns = [{ id: '1234' }];
      Repo.fillWithFallbacks(campaigns, 1);
      expect(campaigns).deep.equal([{ id: '1234' }]);
      done();
    });
    it('should fill with the extra, empty campaigns', function(done) {
      const campaigns = [{ id: '1234' }];
      Repo.fillWithFallbacks(campaigns, 3);
      expect(campaigns).deep.equal([{ id: '1234' }, { id: null }, { id: null }]);
      done();
    });
  });

  describe('#createEmptyAd', function() {
    it('should return an empty ad object.', function (done) {
      const expected = {
        campaignId: '1234',
        creativeId: null,
        fallback: true,
        html: '',
      };
      expect(Repo.createEmptyAd('1234')).to.deep.equal(expected);
      done();
    });
    ['', undefined, null].forEach((value) => {
      it(`should return an empty ad object with a null campaignId when the id value is '${value}'.`, function(done) {
        const expected = {
          campaignId: null,
          creativeId: null,
          fallback: true,
          html: '',
        };
        expect(Repo.createEmptyAd(value)).to.deep.equal(expected);
        done();
      });
    });
  });

  describe('#buildFallbackFor', function() {
    ['', undefined, null, false].forEach((fallback) => {
      it(`should return an empty ad object when the template fallback is '${fallback}'`, function (done) {
        const template = { fallback };
        const requestURL = 'http://www.foo.com';
        const event = {
          uuid: '92e998a7-e596-4747-a233-09108938c8d4',
          pid: '5aa03a87be66ee000110c13b',
          cid: '5aabc20d62a17f0001bbcba4',
        };


        const trackers = Repo.createTrackers(requestURL, event);
        const beacon = Repo.createImgBeacon(trackers);

        const expected = {
          campaignId: event.cid,
          creativeId: null,
          fallback: true,
        };
        const result = Repo.buildFallbackFor({
          template,
          requestURL,
          event,
        });
        expect(result).to.be.an('object');
        ['campaignId, creativeId, fallback'].forEach(k => expect(result[k]).to.equal(expected[k]));
        testImageBeacon(result.html);
        done();
      });
    });

    it('should render the ad with the fallback template and vars.', function(done) {
      const template = { fallback: '<div>{{ var }}</div>' };
      const requestURL = 'http://www.foo.com';
      const event = {
        uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        pid: '5aa03a87be66ee000110c13b',
        cid: '5aabc20d62a17f0001bbcba4',
      };

      const expected = {
        campaignId: event.cid,
        creativeId: null,
        fallback: true,
        html: '<div>Variable here!</div>',
      };
      const fallbackVars = { var: 'Variable here!' };
      const result = Repo.buildFallbackFor({
        template,
        fallbackVars,
        requestURL,
        event,
      });
      expect(result).to.be.an('object');
      ['campaignId, creativeId, fallback'].forEach(k => expect(result[k]).to.equal(expected[k]));
      done();
    });

    it('should render the ad with the fallback template and beacon.', function(done) {
      const template = { fallback: '<div>{{ foo }}</div>{{{ beacon }}}' };
      const requestURL = 'http://www.foo.com';
      const event = {
        uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        pid: '5aa03a87be66ee000110c13b',
        cid: '5aabc20d62a17f0001bbcba4',
      };

      const trackers = Repo.createTrackers(requestURL, event);
      const beacon = Repo.createImgBeacon(trackers);

      const expected = {
        campaignId: event.cid,
        creativeId: null,
        fallback: true,
      };
      const fallbackVars = { foo: 'Variable here!' };

      const result = Repo.buildFallbackFor({
        template,
        fallbackVars,
        requestURL,
        event,
      });
      expect(result).to.be.an('object');
      ['campaignId, creativeId, fallback'].forEach(k => expect(result[k]).to.equal(expected[k]));
      expect(result.html).to.match(/^<div>Variable here!<\/div>/);
      testContainsImageBeacon(result.html)
      done();
    });

  });

  describe('#createImgBeacon', function() {
    it('should return the tracker HMTL snippet.', function(done) {
      const expected = '<div data-fortnight-type="placement"><img data-fortnight-view="pending" data-fortnight-beacon="http://www.foo.com/e/abcd/view.gif" src="http://www.foo.com/e/abcd/load.gif"></div>';
      const result = Repo.createImgBeacon({ load: 'http://www.foo.com/e/abcd/load.gif', view: 'http://www.foo.com/e/abcd/view.gif' });
      expect(result).to.equal(expected);
      done();
    });
  });

  describe('#createTracker', function() {
    beforeEach(function() {
      sandbox.spy(jwt, 'sign');
    });
    afterEach(function() {
      sandbox.restore();
    });
    it('should create the URL.', function(done) {
      const type = 'view';
      const requestURL = 'http://www.foo.com';
      const event = {
        uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        pid: '5aa03a87be66ee000110c13b',
        cid: '5aabc20d62a17f0001bbcba4',
      };

      const url = Repo.createTracker(type, requestURL, event);
      expect(url).to.match(/^http:\/\/www\.foo\.com\/e\/.*\/view\.gif$/);
      sinon.assert.calledOnce(jwt.sign);
      sinon.assert.calledWith(jwt.sign, event, sinon.match.any, { noTimestamp: true });
      done();
    });
  });

  describe('#buildAdFor', function() {
    let campaign;
    beforeEach(function() {
      sandbox.spy(Repo, 'buildFallbackFor');
      sandbox.spy(Repo, 'createTrackers');
      sandbox.spy(Repo, 'createCampaignRedirect');
      sandbox.spy(Repo, 'createImgBeacon');
      sandbox.spy(TemplateRepo, 'render');
    });
    afterEach(function() {
      sandbox.restore();
    });
    before(async function() {
      campaign = await createCampaign();
      campaign.set('creatives', []);
    });

    it('should build a fallback when the creatives are empty.', function(done) {
      const params = {
        campaign,
        template: { fallback: null },
        fallbackVars: {},
        requestURL: 'http://www.foo.com',
        event: {
          cid: campaign.id,
          pid: '5aa03a87be66ee000110c13b',
          uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        },
      };

      const result = Repo.buildAdFor(params);
      sinon.assert.calledOnce(Repo.buildFallbackFor);
      sinon.assert.notCalled(TemplateRepo.render);
      done();
    });

    ['', null, undefined].forEach((value) => {
      it(`should build a fallback when the campaign id value is '${value}'`, function(done) {
        const params = {
          campaign: { id: value },
          template: { fallback: null },
          fallbackVars: {},
          requestURL: 'http://www.foo.com',
          event: {
            cid: campaign.id,
            pid: '5aa03a87be66ee000110c13b',
            uuid: '92e998a7-e596-4747-a233-09108938c8d4',
          },
        };

        const result = Repo.buildAdFor(params);
        sinon.assert.calledOnce(Repo.buildFallbackFor);
        sinon.assert.notCalled(TemplateRepo.render);
        done();
      });
    });

    it('should build the rendered ad object.', function(done) {
      campaign.set('creatives.0', {});
      const creative = campaign.get('creatives.0');
      const params = {
        campaign,
        template: { html: '<div>{{ campaign.id }}</div><span>{{ creative.id }}</span>' },
        fallbackVars: {},
        requestURL: 'http://www.foo.com',
        event: {
          cid: campaign.id,
          pid: '5aa03a87be66ee000110c13b',
          uuid: '92e998a7-e596-4747-a233-09108938c8d4',
        },
      };

      const expected = {
        campaignId: campaign.id,
        creativeId: creative.id,
        fallback: false,
        html: `<div>${campaign.id}</div><span>${creative.id}</span>`,
      };
      expect(Repo.buildAdFor(params)).to.deep.equal(expected);
      sinon.assert.calledOnce(Repo.createCampaignRedirect);
      sinon.assert.calledOnce(Repo.createTrackers);
      sinon.assert.calledOnce(Repo.createImgBeacon);
      sinon.assert.calledOnce(TemplateRepo.render);
      sinon.assert.notCalled(Repo.buildFallbackFor);

      done();
    });

  });

  describe('#findFor', function() {
    const requestURL = 'https://somedomain.com';

    beforeEach(function() {
      sandbox.spy(Repo, 'getPlacementAndTemplate');
      sandbox.spy(Repo, 'queryCampaigns');
      sandbox.spy(Repo, 'fillWithFallbacks');
      sandbox.spy(Repo, 'createRequestEvent');
      sandbox.spy(Repo, 'buildAdFor');
    });
    afterEach(function() {
      sandbox.restore();
    });

    let placement;
    let template;
    before(async function() {
      placement = await createPlacement();
      template = await createTemplate();
      await AnalyticsEvent.remove();
    });
    after(async function() {
      await AnalyticsEvent.remove();
    });

    it('should reject when no request URL is provided.', async function() {
      const placementId = placement.id;
      const templateId = template.id;
      await expect(Repo.findFor({ placementId, templateId, requestURL: '' })).to.be.rejectedWith(Error, 'No request URL was provided');
    });

    it('should throw a not implemented error if greater than 1', async function() {
      const placementId = placement.id;
      const templateId = template.id;
      const num = 2;
      await expect(Repo.findFor({ placementId, templateId, requestURL, num })).to.be.rejectedWith(Error, 'Requesting more than one ad in a request is not yet implemented');
    });

    it('should reject when the num is higher than 10.', async function() {
      const placementId = placement.id;
      const templateId = template.id;
      const num = 11;
      await expect(Repo.findFor({ placementId, templateId, num, requestURL })).to.be.rejectedWith(Error, 'You cannot return more than 10 ads in one request.');
    });

    it('should reject when no params are sent', async function() {
      await expect(Repo.findFor()).to.be.rejectedWith(Error);
    });

    [undefined, 0, -1, 1, null, '1'].forEach((num) => {
      it(`should fulfill with a single campaign when num is ${num}`, async function() {
        const placementId = placement.id;
        const templateId = template.id;

        await expect(Repo.findFor({ placementId, templateId, num, requestURL })).to.be.fulfilled.and.eventually.be.an('array').with.property('length', 1);
        sinon.assert.calledOnce(Repo.getPlacementAndTemplate);
        sinon.assert.calledOnce(Repo.queryCampaigns);
        sinon.assert.calledOnce(Repo.fillWithFallbacks);
        sinon.assert.calledOnce(Repo.createRequestEvent);
        sinon.assert.calledOnce(Repo.buildAdFor);
      });
    });

    it('should should record the proper request event.', async function() {
      await AnalyticsEvent.remove();
      const placementId = placement.id;
      const templateId = template.id;
      const num = 1;

      const promise = Repo.findFor({ placementId, templateId, requestURL, num });
      await expect(promise).to.be.fulfilled;
      const ads = await promise;
      const result = await AnalyticsEvent.findOne({ pid: placementId });
      expect(result).to.be.an('object');

      sinon.assert.calledOnce(Repo.getPlacementAndTemplate);
      sinon.assert.calledOnce(Repo.queryCampaigns);
      sinon.assert.calledOnce(Repo.fillWithFallbacks);
      sinon.assert.calledOnce(Repo.createRequestEvent);
      sinon.assert.calledOnce(Repo.buildAdFor);
    });
  });

  describe('#injectUTMParams', function() {
    it('should inject the params when the source URL does not have a query string.', function(done) {
      const url = 'http://www.google.com';
      const event = {
        pid: '5ab00ccdfd9ea400012760df',
        uuid: 'db1a4977-6ef8-4039-959d-99f95b839eae',
      };
      const injected = Repo.injectUTMParams(url, event);
      expect(injected).to.equal(`${url}/?utm_source=fortnight&utm_medium=fallback&utm_campaign=${event.pid}&utm_content=${event.uuid}`)
      done();
    });
    it('should inject the params when the source URL has a query string.', function(done) {
      const url = 'http://www.google.com?foo=bar&baz=blek';
      const event = {
        pid: '5ab00ccdfd9ea400012760df',
        uuid: 'db1a4977-6ef8-4039-959d-99f95b839eae',
      };
      const injected = Repo.injectUTMParams(url, event);
      expect(injected).to.equal(`http://www.google.com/?foo=bar&baz=blek&utm_source=fortnight&utm_medium=fallback&utm_campaign=${event.pid}&utm_content=${event.uuid}`)
      done();
    });
  });

});