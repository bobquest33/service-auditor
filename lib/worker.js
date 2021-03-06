'use strict';

const Async = require('async');
const Mongoose = require('mongoose');
const Storj = require('storj-lib');
const MongoAdapter = require('storj-mongodb-adapter');
const Complex = require('storj-complex');
const Log = require('./logger');
const StorageModels = require('storj-service-storage-models');
const AuditModel = require('./fullauditmodel');

function AuditWorker(options) {
  this._options = options;
  this._storjClient = Complex.createClient(this._options.storjClient);
  this._mongoConnection = Mongoose.createConnection(
    this._options.mongo.uri,
    this._options.mongo.options
  );

  this._storjModels = new StorageModels(this._options.mongo.uri, this._options.mongo.options);
  this._auditModel = this._storjModels.models.FullAudit;
  this._contactModel = this._storjModels.models.Contact;
  this._mongoAdapter = new MongoAdapter(this._storjModels);
  this._manager = new Storj.StorageManager(this._mongoAdapter);
  this.queue = Async.queue(
    this.handleIncomingAudit.bind(this),
    this._options.maxConcurrency
  );
}

AuditWorker.prototype.start = function() {
  this._auditModel.popReadyAudits((cursor) => {
    this._readyAuditsCursor = cursor;
    this.queue.unsaturated = () => {
      this._readyAuditsCursor.next(this._addToQueue.bind(this));
    };
    this.queue.unsaturated();
  });
};

AuditWorker.prototype._addToQueue = function(err, audit) {
  if(err) { Log.error(err.message); }

  if(audit === null) {
    //no-op, don't attempt to iterate null cursor more than once
    this.queue.unsaturated = () => {};
    this._sleep();
    return;
  }

  this.queue.push(audit);
};

AuditWorker.prototype._sleep = function() {
  var interval = setTimeout(() => {
      this.start();
    },
    this._options.sleepTime
  );

  return interval;
};

AuditWorker.prototype.verify = function(audit, callback) {
  var contact;

  const handleStorageItemLookup = (err, storageItem) => {
    if(err) { return callback(err); }

    this._storjClient.getStorageProof(
      contact,
      storageItem,
      (err, proof) => {
        if(err) { return callback(err); }
        var verification = new Storj.Verification(proof);
        var result = verification.verify(audit.root, audit.depth);
        var hasPassed = result[0] === result[1];
        return callback(null, audit, hasPassed);
      }
    );
  };

  const handleContactLookup = (err, farmer) => {
    if(err) { return callback(err); }
    contact = new Storj.Contact(farmer);
    //TODO: ideally find a way to remove this manager and simply query mongo
    this._manager.load(audit.hash, handleStorageItemLookup);
  };

  this._contactModel.findOne(
    {_id: audit.id},
    handleContactLookup
  );
};


AuditWorker.prototype.commit = function(audit, hasPassed, callback) {
  this._auditModel.handleAuditResult(audit, hasPassed, function(err, isSuccess) {
    if(err) { return callback(err); }
    return callback(null, isSuccess);
  });
};

AuditWorker.prototype.handleIncomingAudit = function(audit, callback) {
  this.verify(audit, (err, audit, hasPassed) => {
    this.commit(audit, hasPassed, (err, isSuccess) => {
      return callback(err, isSuccess);
    });
  });
};

module.exports = AuditWorker;
