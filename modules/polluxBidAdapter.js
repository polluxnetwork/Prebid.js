import * as utils from 'src/utils';
import { registerBidder } from 'src/adapters/bidderFactory';

const BIDDER_CODE = 'pollux';
const PLX_ENDPOINT_URL = '//adn.plxnt.com/prebid/v1';
const PLX_CURRENCY = 'EUR';
const PLX_TTL = 3600;
const PLX_NETREVENUE = true;

export const spec = {
  code: BIDDER_CODE,
  aliases: ['plx'],
  /**
     * Determines whether or not the given bid request is valid.
     *
     * @param {BidRequest} bid The bid params to validate.
     * @return boolean True if this is a valid bid, and false otherwise.
     */
  isBidRequestValid: function(bid) {
    if (!bid.hasOwnProperty('params') || !bid.params.hasOwnProperty('zone')) {
      utils.logError('required param "zone" is missing');
      return false;
    }
    return true;
  },
  /**
     * Make a server request from the list of BidRequests.
     *
     * @param {validBidRequests[]} - an array of bids
     * @return ServerRequest Info describing the request to the server.
     */
  buildRequests: function (validBidRequests) {
    if (!Array.isArray(validBidRequests) || !validBidRequests.length) {
      return [];
    }
    const payload = [];
    var custom_url = null;
    for (var i = 0; i < validBidRequests.length; i++) {
      const bid = validBidRequests[i];
      const request = {
        bidId: bid.bidId,
        zones: bid.params.zone,
        sizes: bid.sizes
      };
      if (bid.bidderUrl && !custom_url) {
        custom_url = bid.bidderUrl;
      }
      payload.push(request);
    }
    const payloadString = JSON.stringify(payload);
    // build url parameters
    const domain = utils.getParameterByName('domain');
    const tracker2 = utils.getParameterByName('tracker2');
    const url_params = {};
    if (domain) {
      url_params.domain = domain;
    } else {
      url_params.domain = utils.getTopWindowUrl();
    }
    if (tracker2) {
      url_params.tracker2 = tracker2;
    }
    // build url
    var bidder_url = custom_url || PLX_ENDPOINT_URL;
    if (url_params) {
      bidder_url = bidder_url + '?' + utils.parseQueryStringParameters(url_params);
    }
    utils.logMessage('Pollux request built: ' + bidder_url);
    return {
      method: 'POST',
      url: bidder_url,
      data: payloadString
    };
  },
  /**
     * Unpack the response from the server into a list of bids.
     *
     * @param {*} serverResponse A successful response from the server.
     * @return {Bid[]} An array of bids which were nested inside the server.
     */
  interpretResponse: function(serverResponse, bidRequest) {
    if (!Array.isArray(serverResponse) || !serverResponse.length) {
      utils.logMessage('No prebid response from polluxHandler for bid requests:');
      utils.logMessage(bidRequest);
      return [];
    }
    // loop through serverResponses
    const bidResponses = [];
    for (var b in serverResponse) {
      var bid = serverResponse[b];
      const bidResponse = {
        requestId: bid.bidId, // not request id, it's bid's id
        cpm: parseFloat(bid.cpm),
        width: parseInt(bid.width),
        height: parseInt(bid.height),
        ttl: PLX_TTL,
        creativeId: bid.creativeId,
        netRevenue: PLX_NETREVENUE,
        currency: PLX_CURRENCY
      };
      if (bid.ad_type === 'url') {
        bidResponse.adUrl = bid.ad;
      } else {
        bidResponse.ad = bid.ad;
      }
      if (bid.referrer) {
        bidResponse.referrer = bid.referrer;
      }
      bidResponses.push(bidResponse);
    }
    return bidResponses;
  }
};
registerBidder(spec);
