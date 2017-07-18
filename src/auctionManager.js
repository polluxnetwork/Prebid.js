const adaptermanager = require('./adaptermanager');
const utils = require('./utils');
const events = require('./events');
const CONSTANTS = require('./constants.json');
import { uniques, flatten, adUnitsFilter, getBidderRequest, timestamp } from './utils';
import { getPriceBucketString } from './cpmBucketManager';

export const auctionManager = (function() {
  var _auctions = [];
  var callback;
  let _customPriceBucket;
  var defaultBidderSettingsMap = {};

  function bidsBackAdUnit(adUnitCode, auction) {
    const requested = auction.getBidderRequests()
      .map(request => request.bids
        .filter(adUnitsFilter.bind(this, $$PREBID_GLOBAL$$._adUnitCodes))
        .filter(bid => bid.placementCode === adUnitCode))
      .reduce(flatten, [])
      .map(bid => {
        return bid.bidder === 'indexExchange'
          ? bid.sizes.length
          : 1;
      }).reduce(add, 0);

    const received = $$PREBID_GLOBAL$$._bidsReceived.filter(bid => bid.adUnitCode === adUnitCode).length;
    return requested === received;
  }

  function getStandardBidderSettings() {
    let bidder_settings = $$PREBID_GLOBAL$$.bidderSettings;
    if (!bidder_settings[CONSTANTS.JSON_MAPPING.BD_SETTING_STANDARD]) {
      bidder_settings[CONSTANTS.JSON_MAPPING.BD_SETTING_STANDARD] = {
        adserverTargeting: [
          {
            key: 'hb_bidder',
            val: function (bidResponse) {
              return bidResponse.bidderCode;
            }
          }, {
            key: 'hb_adid',
            val: function (bidResponse) {
              return bidResponse.adId;
            }
          }, {
            key: 'hb_pb',
            val: function (bidResponse) {
              if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.AUTO) {
                return bidResponse.pbAg;
              } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.DENSE) {
                return bidResponse.pbDg;
              } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.LOW) {
                return bidResponse.pbLg;
              } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.MEDIUM) {
                return bidResponse.pbMg;
              } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.HIGH) {
                return bidResponse.pbHg;
              } else if (_granularity === CONSTANTS.GRANULARITY_OPTIONS.CUSTOM) {
                return bidResponse.pbCg;
              }
            }
          }, {
            key: 'hb_size',
            val: function (bidResponse) {
              return bidResponse.size;
            }
          }, {
            key: 'hb_deal',
            val: function (bidResponse) {
              return bidResponse.dealId;
            }
          }
        ]
      };
    }
    return bidder_settings[CONSTANTS.JSON_MAPPING.BD_SETTING_STANDARD];
  }

  function setKeys(keyValues, bidderSettings, custBidObj) {
    var targeting = bidderSettings[CONSTANTS.JSON_MAPPING.ADSERVER_TARGETING];
    custBidObj.size = custBidObj.getSize();

    utils._each(targeting, function (kvPair) {
      var key = kvPair.key;
      var value = kvPair.val;

      if (keyValues[key]) {
        utils.logWarn('The key: ' + key + ' is getting ovewritten');
      }

      if (utils.isFn(value)) {
        try {
          value = value(custBidObj);
        } catch (e) {
          utils.logError('bidmanager', 'ERROR', e);
        }
      }

      if (
        (typeof bidderSettings.suppressEmptyKeys !== 'undefined' && bidderSettings.suppressEmptyKeys === true ||
        key === 'hb_deal') && // hb_deal is suppressed automatically if not set
        (
          utils.isEmptyStr(value) ||
          value === null ||
          value === undefined
        )
      ) {
        utils.logInfo("suppressing empty key '" + key + "' from adserver targeting");
      } else {
        keyValues[key] = value;
      }
    });

    return keyValues;
  }

  function getKeyValueTargetingPairs(bidderCode, custBidObj) {
    var keyValues = {};
    var bidder_settings = $$PREBID_GLOBAL$$.bidderSettings;

    // 1) set the keys from "standard" setting or from prebid defaults
    if (custBidObj && bidder_settings) {
      // initialize default if not set
      const standardSettings = getStandardBidderSettings();
      setKeys(keyValues, standardSettings, custBidObj);
    }

    // 2) set keys from specific bidder setting override if they exist
    if (bidderCode && custBidObj && bidder_settings && bidder_settings[bidderCode] && bidder_settings[bidderCode][CONSTANTS.JSON_MAPPING.ADSERVER_TARGETING]) {
      setKeys(keyValues, bidder_settings[bidderCode], custBidObj);
      custBidObj.alwaysUseBid = bidder_settings[bidderCode].alwaysUseBid;
      custBidObj.sendStandardTargeting = bidder_settings[bidderCode].sendStandardTargeting;
    }

    // 2) set keys from standard setting. NOTE: this API doesn't seem to be in use by any Adapter
    else if (defaultBidderSettingsMap[bidderCode]) {
      setKeys(keyValues, defaultBidderSettingsMap[bidderCode], custBidObj);
      custBidObj.alwaysUseBid = defaultBidderSettingsMap[bidderCode].alwaysUseBid;
      custBidObj.sendStandardTargeting = defaultBidderSettingsMap[bidderCode].sendStandardTargeting;
    }

    // set native key value targeting
    if (custBidObj.native) {
      Object.keys(custBidObj.native).forEach(asset => {
        const key = NATIVE_KEYS[asset];
        const value = custBidObj.native[asset];
        if (key) { keyValues[key] = value; }
      });
    }

    return keyValues;
  }

  function _createAuction() {
    const auction = new Auction();
    _addAuction(auction);
    return auction;
  }

  function _getAuction(auctionId) {
    return _auctions.find(auction => auction.getAuctionId() === auctionId);
  }

  function _addAuction(auction) {
    _auctions.push(auction);
  }

  function _removeAuction(auction) {
    _auctions.splice(_auctions.indexOf(auction), 1);
  }

  function _findAuctionsByBidderCode(bidderCode) {
    var _bidderCode = bidderCode;
    return _auctions.filter(_auction => _auction.getBidderRequests()
      .filter(bidderRequest => bidderRequest.bidderCode === _bidderCode));
  }

  function executeCallback() {
    // get all auctions
    // auction.setCallback
    // delete all auction instances
    callback.apply($$PREBID_GLOBAL$$);
  }

  function Auction() {
    var _id = utils.getUniqueIdentifierStr();
    var _adUnits = [];
    var _targeting = [];
    var _bidderRequests = [];
    var _bidsReceived = [];
    var _auctionStart;
    var _auctionId;

    this.setAuctionId = (auctionId) => {
      _auctionId = auctionId;
    }

    this.setAuctionStart = (auctionStart) => {
      _auctionStart = auctionStart;
    }

    this.setAdUnits = (adUnits) => _adUnits = adUnits;
    this.setTargeting = (targeting) => _targeting = targeting;
    this.setBidderRequests = (bidderRequests) => _bidderRequests = _bidderRequests.concat(bidderRequests);
    this.setBidsReceived = (bidsReceived) => _bidsReceived = _bidsReceived.concat(bidsReceived);

    this.getId = () => _id;
    this.getAdUnits = () => _adUnits;
    this.getBidderRequests = () => _bidderRequests;
    this.getBidsReceived = () => _bidsReceived;
    this.getTargeting = () => _targeting;
    this.getAuctionStart = () => _auctionStart;
    this.getAuctionId = () => _auctionId;
    this.getBidderRequestByCode = (bidderCode) => {
      return {};
      //return this.getBidderRequests().filter()
    }

    this.addBidResponse = (adUnitCode, bid, auctionId) => {
      let auction = _getAuction(auctionId);
      if (isValid()) {
        prepareBidForAuction();

        if (bid.mediaType === 'video') {
          tryAddVideoBid(bid);
        } else {
          doCallbacksIfNeeded();
          addBidToAuction(bid);
        }
      }

      // Validate the arguments sent to us by the adapter. If this returns false, the bid should be totally ignored.
      function isValid() {
        function errorMessage(msg) {
          return `Invalid bid from ${bid.bidderCode}. Ignoring bid: ${msg}`;
        }

        if (!adUnitCode) {
          utils.logWarn('No adUnitCode was supplied to addBidResponse.');
          return false;
        }
        if (!bid) {
          utils.logWarn(`Some adapter tried to add an undefined bid for ${adUnitCode}.`);
          return false;
        }
        if (bid.mediaType === 'native' && !nativeBidIsValid(bid)) {
          utils.logError(errorMessage('Native bid missing some required properties.'));
          return false;
        }
        if (bid.mediaType === 'video' && !bid.vastUrl) {
          utils.logError(errorMessage(`Video bid does not have required vastUrl property.`));
          return false;
        }
        return true;
      }

      // Postprocess the bids so that all the universal properties exist, no matter which bidder they came from.
      // This should be called before addBidToAuction().
      function prepareBidForAuction() {
        // Let listeners know that now is the time to adjust the bid, if they want to.
        //
        // This must be fired first, so that we calculate derived values from the updates
        events.emit(CONSTANTS.EVENTS.BID_ADJUSTMENT, bid);

        let bidderRequest = auction.getBidderRequestByCode();
        const start = bidderRequest.start;

        Object.assign(bid, {
          auctionId: auctionId,
          responseTimestamp: timestamp(),
          requestTimestamp: start,
          cpm: parseFloat(bid.cpm) || 0,
          bidder: bid.bidderCode,
          adUnitCode
        });

        bid.timeToRespond = bid.responseTimestamp - bid.requestTimestamp;

        const priceStringsObj = getPriceBucketString(bid.cpm, _customPriceBucket);
        bid.pbLg = priceStringsObj.low;
        bid.pbMg = priceStringsObj.med;
        bid.pbHg = priceStringsObj.high;
        bid.pbAg = priceStringsObj.auto;
        bid.pbDg = priceStringsObj.dense;
        bid.pbCg = priceStringsObj.custom;

        // if there is any key value pairs to map do here
        var keyValues = {};
        if (bid.bidderCode && (bid.cpm > 0 || bid.dealId)) {
          keyValues = getKeyValueTargetingPairs(bid.bidderCode, bid);
        }

        bid.adserverTargeting = keyValues;
      }

      function doCallbacksIfNeeded() {
        if (bid.timeToRespond > $$PREBID_GLOBAL$$.cbTimeout + $$PREBID_GLOBAL$$.timeoutBuffer) {
          executeCallback();
        }
      }

      // Add a bid to the auction.
      function addBidToAuction() {
        events.emit(CONSTANTS.EVENTS.BID_RESPONSE, bid);
        auction.setBidsReceived(bid);

        // Removing this as we are deprecating pbjs.addCallback public api
        // if (bid.adUnitCode && bidsBackAdUnit(bid.adUnitCode, auction)) {
        //   triggerAdUnitCallbacks(bid.adUnitCode);
        // }

        if (auction.bidsBackAll()) {
          executeCallback();
        }
      }
    }

    this.bidsBackAll = () => {
      const requested = this.getBidderRequests()
        .map(request => request.bids)
        .reduce(flatten, [])
        .filter(adUnitsFilter.bind(this, $$PREBID_GLOBAL$$._adUnitCodes))
        .map(bid => {
          return bid.bidder === 'indexExchange'
            ? bid.sizes.length
            : 1;
        }).reduce((a, b) => a + b, 0);

      const received = this.getBidsReceived()
        .filter(adUnitsFilter.bind(this, $$PREBID_GLOBAL$$._adUnitCodes)).length;

      return requested === received;
    }

    this.callBids = (cbTimeout) => {
      this.setAuctionId(utils.generateUUID());
      this.setAuctionStart(Date.now());
      const auctionInit = {
        timestamp: this.getAuctionStart(),
        auctionId: this.getAuctionId(),
        timeout: cbTimeout
      };
      events.emit(CONSTANTS.EVENTS.AUCTION_INIT, auctionInit);

      adaptermanager.callBids(this, cbTimeout);
    };
  }

  return {
    createAuction() {
      return _createAuction();
    },

    getAuction() {
      return _getAuction(...arguments);
    },

    getSingleAuction() {
      return _auctions[0] || _createAuction();
    },

    findAuctionByBidderCode() {
      return _findAuctionsByBidderCode(...arguments);
    },

    setCallback(cb) {
      callback = cb;
    },

    findBidderRequestByBidId({ bidId }) {
      return _auctions.map(auction => auction.getBidderRequests()
        .find(request => request.bids
          .find(bid => bid.bidId === bidId)))[0] || { start: null };
    },

    findBidderRequestByBidParamImpId({ impId }) {
      return _auctions.map(auction => auction.getBidderRequests()
        .find(request => request.bids
          .find(bid => bid.params && bid.params.impId === impId)));
    },

    findAuctionByBidId(bidId) {
      return _auctions.find(auction => auction.getBidderRequests()
        .find(request => request.bids
          .find(bid => bid.bidId === bidId)));
    },

    findBidRequest({ bidId }) {
      return _auctions.map(auction => auction.getBidderRequests()
        .map(request => request.bids
          .find(bid => bid.bidId === bidId)))[0]
        .filter(bid => bid !== undefined)[0];
    }
  };
}());
