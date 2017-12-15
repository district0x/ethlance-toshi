const Config = require('./Config');
const fs = require('fs');
const mkdirp = require('mkdirp');
const pg = require('pg');
const url = require('url')
const unit = require('./unit');
const SOFA = require('sofa-js');
const Fiat = require('./Fiat')
const Logger = require('./Logger');
const EthService = require('./EthService')
const IdService = require('./IdService')

class Session {
  constructor(bot, storage, config, address, onReady) {
    this.bot = bot;
    this.config = config;
    this.storage = storage;

    this.address = address || "anonymous";
    this.data = {
      address: this.address
    };
    this.thread = null;
    this.state = null;

    this.load(onReady);
  }

  get(key) {
    if (key === 'tokenId') {
      return this.address;
    }
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.flush();
  }

  setState(name) {
    this.state = name;
    this.set('_state', name);
  }

  openThread(name) {
    this.closeThread();
    this.set('_thread', name)
    this.thread = this.bot.threads[name];
    this.thread.open(this);
  }

  closeThread() {
    if (this.thread) {
      this.thread.close(this);
    }
    this.thread = null;
    this.set('_thread', null);
    this.setState(null)
  }

  reset() {
    this.closeThread()
    this.setState(null)
    this.data = {
      address: this.address
    };
    this.flush();
  }

  reply(message) {
    if (this.address == "anonymous") {
      Logger.error("Cannot send messages to anonymous session");
      return;
    }
    this.bot.client.send(this.address, message);
  }

  balance(address, fiat_type) {
    if (address) {
      if (!address.startsWith("0x")) {
        // assume fiat_type
        fiat_type = address;
        address = this.config.paymentAddress;
      }
    } else {
      address = this.config.paymentAddress;
    }
    let getbal = EthService.getBalance(address);
    if (!fiat_type || fiat_type.toLowerCase() == 'eth') {
      fiat_type = 'ether';
    }
    if (fiat_type.toLowerCase() in unit.unitMap) {
      return getbal.then(([bal, _]) => {
        return Promise.resolve(unit.fromWei(bal, fiat_type.toLowerCase()));
      });
    } else {
      return getbal.then(([bal, _]) => {
        return Fiat.fetch().then((fiat) => {
          return Promise.resolve(fiat[fiat_type.toUpperCase()].fromEth(unit.fromWei(bal, 'ether')));
        });
      });
    }

  }

  sendEth(value, options, callback) {
    value = '0x' + unit.toWei(value, 'ether').toString(16);
    return this.sendWei(value, options, callback);
  }

  sendWei(value, options, callback) {
    if (!callback && typeof options == "function") {
      callback = options;
      options = {};
    } else if (typeof options == "string") {
      options = {to: options};
    } else if (!options) {
      options = {};
    } else if (typeof options != "object") {
      if (callback) { callback(this, "Invalid options", null); }
      return;
    }
    // missing `to` is valid, but not the standard usecase
    // this makes it require explicit `null` to set no `to` address
    if (!options.hasOwnProperty('to')) {
      if (!this.user.payment_address) {
        if (callback) { callback(this, "Cannot send transactions to users with no payment address", null); }
        return;
      } else {
        options.to = this.user.payment_address;
      }
    } else if (!options.to) {
      delete options.to;
    }
    options.value = value;

    // convert arguments to hex
    ["value", "gasPrice", "gas", "nonce"].forEach((key) => {
      if (options.hasOwnProperty(key) && typeof options[key] == "number") {
        options[key] = "0x" + Math.floor(options[key]).toString(16);
      }
    });
    if (options.hasOwnProperty("data") && options.data instanceof Buffer) {
      options.data = "0x" + options.data.toString("hex");
    }

    this.bot.client.rpc(this, {
      method: "sendTransaction",
      params: options
    }, (session, error, result) => {
      if (result) {
        session.reply(SOFA.Payment({
          status: "unconfirmed",
          value: value,
          txHash: result.txHash,
          fromAddress: this.config.tokenIdAddress,
          toAddress: options.to
        }));
      }
      if (callback) { callback(session, error, result); }
    });
  }

  requestEth(value, message) {
    if (!this.user.token_id) {
      Logger.error("Cannot send transactions to users with no payment address");
      return;
    }
    value = '0x' + unit.toWei(value, 'ether').toString(16)
    this.reply(SOFA.PaymentRequest({
      body: message,
      value: value,
      destinationAddress: this.config.paymentAddress
    }));
  }

  load(onReady) {
    this.storage.loadBotSession(this.address).then((data) => {
      this.data = data;
      if (this.data._thread) {
        this.thread = this.bot.threads[this.data._thread];
      }
      if (this.data._state) {
        this.state = this.data._state;
      }
      if (this.address != "anonymous") {
        IdService.getUser(this.address)
          .then((user) => {
            this.user = user;
            onReady();
          })
      } else {
        this.user = {};
        onReady();
      }
    });
  }

  flush() {
    this.data.timestamp = Math.round(new Date().getTime()/1000);
    this.storage.updateBotSession(this.address, this.data);
  }

  get json() {
    return JSON.stringify(this.data);
  }
}

module.exports = Session;
