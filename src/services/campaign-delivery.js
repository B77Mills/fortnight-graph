const _ = require('lodash');
const createError = require('http-errors');
const uuidv4 = require('uuid/v4');
const AnalyticsEvent = require('../models/analytics/event');
const BotDetector = require('../services/bot-detector');
const Campaign = require('../models/campaign');
const Image = require('../models/image');
const Placement = require('../models/placement');
const Template = require('../models/template');
const Utils = require('../utils');
const Account = require('./account');

module.exports = {
  /**
   *
   * @param {*} options
   */
  parseOptions(options) {
    if (!options) return {};
    try {
      return JSON.parse(String(options));
    } catch (e) {
      return {};
    }
  },

  /**
   * Queries for campaigns.
   *
   * @param {object} params
   * @param {Date} params.startDate
   * @param {string} params.placementId
   * @param {object} params.keyValues
   * @param {number} params.limit
   * @return {Promise}
   */
  async queryCampaigns({
    startDate,
    placementId,
    keyValues,
    limit,
  }) {
    const criteria = {
      deleted: false,
      ready: true,
      paused: false,
      'criteria.start': { $lte: startDate },
      'criteria.placementIds': placementId,
      $and: [
        {
          $or: [
            { 'criteria.end': { $exists: false } },
            { 'criteria.end': null },
            { 'criteria.end': { $gt: startDate } },
          ],
        },
      ],
    };

    Utils.cleanValues(keyValues);
    // Temporarily disable querying by custom key/values.
    // const kvs = Utils.cleanValues(keyValues);
    // const kvsOr = [];
    // Object.keys(kvs).forEach((key) => {
    //   kvsOr.push({
    //     'criteria.kvs': { $elemMatch: { key, value: kvs[key] } },
    //   });
    // });
    // if (kvsOr.length !== 0) {
    //   criteria.$and.push({
    //     $or: kvsOr,
    //   });
    // } else {
    //   // Ensure that only ads _without_ custom key values are returned.
    //   criteria.$and.push({
    //     'criteria.kvs.0': { $exists: false },
    //   });
    // }
    const campaigns = await Campaign.find(criteria);
    return this.selectCampaigns(campaigns, limit);
  },

  /**
   * Selects the campaigns to return.
   * Shuffles the campaigns and returns the number based on the limit.
   *
   * @param {array} campaigns
   * @param {number} limit
   * @return {array}
   */
  selectCampaigns(campaigns, limit) {
    const shuffled = _.shuffle(campaigns);
    return shuffled.slice(0, limit);
  },

  /**
   *
   * @param {object} params
   * @param {string} params.placementId
   * @return {Promise}
   */
  async getPlacementAndTemplate({ placementId } = {}) {
    if (!placementId) throw createError(400, 'No placement ID was provided.');

    const placement = await Placement.findOne({ _id: placementId }, {
      _id: 1,
      templateId: 1,
      reservePct: 1,
    });
    if (!placement) throw createError(404, `No placement exists for ID '${placementId}'`);

    const template = await Template.findOne({ _id: placement.templateId }, {
      html: 1,
      fallback: 1,
    });
    if (!template) throw createError(404, `No template exists for ID '${placement.templateId}'`);

    return { placement, template };
  },

  /**
   *
   * @param {object} params
   * @param {string} params.placementId The placement identifier.
   * @param {string} params.userAgent The requesting user agent.
   * @param {number} [params.num=1] The number of ads to return. Max of 20.
   * @param {object} [params.vars] An object containing targeting, merge, and fallback vars.
   * @param {object} [params.vars.custom] Custom targeting variables.
   * @param {object} [params.vars.fallback] Fallback template merge variables.
   */
  async findFor({
    placementId,
    userAgent,
    ipAddress,
    num = 1,
    vars = { custom: {}, fallback: {} },
  } = {}) {
    const { placement, template } = await this.getPlacementAndTemplate({ placementId });
    const account = await Account.retrieve();

    const limit = num > 0 ? parseInt(num, 10) : 1;
    if (limit > 10) throw createError(400, 'You cannot return more than 10 ads in one request.');
    if (limit > 1) throw createError(501, 'Requesting more than one ad in a request is not yet implemented.');

    const rp = placement.get('reservePct');
    const ap = account.get('settings.reservePct');
    const reservePct = (rp || ap || 0) / 100;

    const campaigns = Math.random() >= reservePct
      ? await this.queryCampaigns({
        startDate: new Date(),
        placementId: placement.id,
        keyValues: vars.custom,
        limit,
      }) : [];
    this.fillWithFallbacks(campaigns, limit);

    return Promise.all(campaigns.map((campaign) => {
      const event = this.createRequestEvent({
        cid: campaign.id,
        pid: placement.id,
        ua: userAgent,
        kv: vars.custom,
        ip: ipAddress,
      });
      return this.buildAdFor({
        campaign,
        template,
        fallbackVars: vars.fallback,
        event,
      });
    }));
  },

  createRequestEvent({
    cid,
    pid,
    ua,
    kv,
    ip,
  }) {
    const bot = BotDetector.detect(ua);
    return new AnalyticsEvent({
      e: 'request',
      uuid: uuidv4(),
      cid: cid || undefined,
      pid,
      d: new Date(),
      bot,
      ua,
      kv,
      ip,
    });
  },

  fillWithFallbacks(campaigns, limit) {
    if (campaigns.length < limit) {
      const n = limit - campaigns.length;
      for (let i = 0; i < n; i += 1) {
        campaigns.push({ id: null });
      }
    }
  },

  createEmptyAd(campaignId) {
    return {
      campaignId: campaignId || null,
      creativeId: null,
      fallback: true,
      html: '',
    };
  },

  buildFallbackFor({
    template,
    fallbackVars,
    event,
  }) {
    const {
      cid,
      pid,
      uuid,
      kv,
    } = event;
    const ad = this.createEmptyAd(cid);

    if (template.fallback) {
      const vars = Object.assign({}, Object(fallbackVars), {
        pid,
        uuid,
        kv,
      });
      ad.html = Template.render(template.fallback, vars);
    } else {
      ad.html = Template.render(Template.getFallbackFallback(true), { pid, uuid, kv });
    }
    return ad;
  },

  /**
   * Rotates a campaign's creatives randomly.
   * Eventually could use some sort of weighting criteria.
   *
   * @param {Campaign} campaign
   * @return {?Creative}
   */
  async getCreativeFor(campaign) {
    const count = campaign.get('creatives.length');
    if (!count) return null;
    const index = _.random(count - 1);
    const creative = campaign.get(`creatives.${index}`);
    if (!creative) return creative;

    // Append the creative's image.
    const { imageId } = creative;
    if (imageId) creative.image = await Image.findById(imageId);
    return creative;
  },

  async buildAdFor({
    campaign,
    template,
    fallbackVars,
    event,
  }) {
    if (!campaign.id) {
      return this.buildFallbackFor({
        template,
        fallbackVars,
        event,
      });
    }
    const creative = await this.getCreativeFor(campaign);
    if (!creative || !creative.active) {
      // No creative found. Send fallback.
      return this.buildFallbackFor({
        template,
        fallbackVars,
        event,
      });
    }

    const ad = this.createEmptyAd(campaign.id);

    if (creative.image) {
      creative.image.src = await creative.image.getSrc();
    }

    const { uuid, pid, kv } = event;
    const vars = {
      uuid,
      pid,
      kv,
      href: campaign.url,
      campaign,
      creative,
    };
    ad.html = Template.render(template.html, vars);
    ad.creativeId = creative.id;
    ad.fallback = false;
    return ad;
  },
};
