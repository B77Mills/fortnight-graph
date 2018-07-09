const { paginationResolvers } = require('@limit0/mongoose-graphql-pagination');
const Advertiser = require('../../models/advertiser');
const Story = require('../../models/story');
const Image = require('../../models/image');
const StoryRepo = require('../../repositories/story');

module.exports = {
  Story: {
    advertiser: story => Advertiser.findById(story.advertiserId),
    primaryImage: story => Image.findById(story.primaryImageId),
    images: story => Image.find({ _id: { $in: story.imageIds } }),
  },

  /**
   *
   */
  StoryConnection: paginationResolvers.connection,

  /**
   *
   */
  Query: {
    /**
     *
     */
    story: async (root, { input }) => {
      const { id } = input;
      const record = await Story.findById(id);
      if (!record) throw new Error(`No story record found for ID ${id}.`);
      return record;
    },

    /**
     *
     */
    allStories: (root, { input, pagination, sort }) => {
      const { dispositions } = input;
      const criteria = {
        disposition: { $in: dispositions.length ? dispositions : ['Ready', 'Draft'] },
      };
      return new Pagination(Story, { pagination, sort, criteria });
    },

    /**
     *
     */
    searchStories: (root, { pagination, phrase }) => StoryRepo.search(phrase, { pagination }),

    /**
     *
     */
    autocompleteStories: async (root, { pagination, phrase }) => StoryRepo
      .autocomplete(phrase, { pagination }),
  },
  /**
   *
   */
  Mutation: {
    /**
     *
     */
    createStory: (root, { input }, { auth }) => {
      auth.check();
      const { payload } = input;
      const {
        title,
        advertiserId,
        publishedAt,
      } = payload;
      const disposition = publishedAt ? 'Ready' : 'Draft';

      return Story.create({
        title,
        advertiserId,
        publishedAt,
        disposition,
      });
    },

    },

    /**
     *
     */
    updateStory: async (root, { input }, { auth }) => {
      auth.check();
      const { id, payload } = input;
      const {
        title,
        teaser,
        body,
        advertiserId,
        publishedAt,
      } = payload;

      const story = await Story.findById(id);
      if (!story) throw new Error(`Unable to update story: no record was found for ID '${id}'`);

      let disposition = publishedAt ? 'Ready' : 'Draft';
      if (story.disposition === 'Deleted') disposition = 'Deleted';

      story.set({
        title,
        teaser,
        body,
        advertiserId,
        publishedAt,
        disposition,
      });
      return story.save();
    },

    /**
     *
     */
    removeStoryImage: async (root, { storyId, imageId }, { auth }) => {
      auth.check();
      const story = await Story.findById(storyId);
      if (!story) throw new Error(`Unable to remove story image: no record was found for ID '${storyId}'`);
      story.removeImageId(imageId);
      return story.save();
    },

    /**
     *
     */
    addStoryImage: async (root, { storyId, imageId }, { auth }) => {
      auth.check();
      const story = await Story.findById(storyId);
      if (!story) throw new Error(`Unable to add story image: no record was found for ID '${storyId}'`);
      story.addImageId(imageId);
      return story.save();
    },

    /**
     *
     */
    storyPrimaryImage: async (root, { storyId, imageId }, { auth }) => {
      auth.check();
      const story = await Story.findById(storyId);
      if (!story) throw new Error(`Unable to set primary image: no story was found for ID '${storyId}'`);
      story.primaryImageId = imageId || undefined;
      return story.save();
    },
  },
};
