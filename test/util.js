/* eslint-disable no-console */

var AWS = require('aws-sdk');
var tape = require('tape');
var crypto = require('crypto');
var util = require('util');
var messageToEnv = require('../lib/messages').messageToEnv;
var envToRunTaskParams = require('../lib/tasks').envToRunTaskParams;

module.exports.mock = function(name, callback) {
  tape(name, function(assert) {
    var sqs = AWS.SQS;
    var sns = AWS.SNS;
    var ecs = AWS.ECS;
    var log = console.log.bind(console);

    var context = {
      sqs: {
        receiveMessage: [],
        receiveEventMessage: [],
        deleteMessage: [],
        changeMessageVisibility: []
      },
      sns: {
        publish: []
      },
      ecs: {
        runTask: [],
        stopTask: [],
        describeTasks: [],
        describeTaskDefinition: [],
        describeContainerInstances: [],
        listContainerInstances: []
      },
      logs: []
    };

    AWS.SQS = function(config) {
      context.sqs.config = config;
      this.isEventQueue = /event/.test(config.params.QueueUrl);
    };
    AWS.SQS.prototype.receiveMessage = function(params, callback) {
      var messagesToReceive;
      if (this.isEventQueue) {
        messagesToReceive = context.sqs.eventMessages || [];
        context.sqs.receiveEventMessage.push(params);
      } else {
        messagesToReceive = context.sqs.messages || [];
        context.sqs.receiveMessage.push(params);
      }

      if (!messagesToReceive.length)
        return setImmediate(callback, null, { Messages: [] });
      var max = params.MaxNumberOfMessages || 1;

      var error = false;
      var msgs = messagesToReceive.splice(0, max).map(function(msg) {
        if (msg.MessageId === 'error') error = true;
        msg.Attributes.ApproximateReceiveCount++;
        if (msg.Attributes.ApproximateReceiveCount === 1)
          msg.Attributes.ApproximateFirstReceiveTimestamp = 20;
        return msg;
      });

      if (this.isEventQueue)
        context.sqs.eventMessages = messagesToReceive;
      else
        context.sqs.messages = messagesToReceive;

      if (error) return setImmediate(callback, new Error('Mock SQS error'));
      setImmediate(callback, null, { Messages: msgs });
    };
    AWS.SQS.prototype.deleteMessage = function(params, callback) {
      context.sqs.deleteMessage.push(params);
      if (params.ReceiptHandle === 'missing')
        return callback(new Error('Message does not exist or is not available for visibility timeout change'));
      if (params.ReceiptHandle === 'error')
        return callback(new Error('Mock SQS error'));
      callback();
    };
    AWS.SQS.prototype.changeMessageVisibility = function(params, callback) {
      context.sqs.changeMessageVisibility.push(params);
      if (params.ReceiptHandle === 'missing')
        return callback(new Error('Message does not exist or is not available for visibility timeout change'));
      if (params.ReceiptHandle === 'error')
        return callback(new Error('Mock SQS error'));
      callback();
    };

    AWS.SNS = function(config) { context.sns.config = config; };
    AWS.SNS.prototype.publish = function(params, callback) {
      context.sns.publish.push(params);
      callback();
    };

    var tasks = {};
    context.ecs.resourceFail = 0;

    AWS.ECS = function(config) { context.ecs.config = config; };
    AWS.ECS.prototype.runTask = function(params, callback) {
      context.ecs.runTask.push(params);

      if (params.overrides.containerOverrides[0].environment[0].name === 'error')
        return callback(new Error('Mock ECS error'));

      if (params.overrides.containerOverrides[0].environment[0].name === 'failure')
        return callback(null, { tasks: [], failures: [{ reason: 'unrecognized' }] });

      if (params.overrides.containerOverrides[0].environment[0].name === 'cannotPullContainer') {
        var err = new Error('API error (500): Get https://234858372212.dkr.ecr.us-east-1.amazonaws.com/v1/_ping: dial tcp: i/o timeout');
        err.name = 'CannotPullContainerError';
        return callback(err);
      }

      if (params.overrides.containerOverrides[0].environment[0].name === 'resourceMemory') {
        if (context.ecs.resourceFail === 0) {
          context.ecs.resourceFail++;
          return callback(null, { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] });
        }
      }

      if (params.overrides.containerOverrides[0].environment[0].name === 'resourceCpu') {
        if (context.ecs.resourceFail === 0) {
          context.ecs.resourceFail++;
          return callback(null, { tasks: [], failures: [{ reason: 'RESOURCE:CPU' }] });
        }
      }

      var messageId = params.overrides.containerOverrides[0].environment.find(function(item) {
        return item.name === 'MessageId';
      });
      if (messageId && messageId.value === 'ecs-error') return callback(new Error('Mock ECS error'));
      if (messageId && messageId.value === 'ecs-failure') {
        if (context.ecs.resourceFail === 0) {
          context.ecs.resourceFail++;
          return callback(null, { tasks: [], failures: [{ reason: 'RESOURCE:MEMORY' }] });
        }
      }
      if (messageId && messageId.value === 'ecs-unrecognized')
        return callback(null, { tasks: [], failures: [{ reason: 'unrecognized' }] });

      var arn = crypto.createHash('md5').update(JSON.stringify(params)).digest('hex');
      tasks[arn] = params.overrides.containerOverrides[0].environment;

      callback(null, {
        tasks: [{ taskArn: arn }]
      });
    };

    console.log = function() {
      var msg = util.format.apply(null, arguments);
      context.logs.push(msg);
      log(msg);
    };

    var end = assert.end.bind(assert);
    delete assert.plan;
    assert.end = function(err) {
      AWS.SQS = sqs;
      AWS.SNS = sns;
      AWS.ECS = ecs;
      console.log = log;
      if (err) end(err);
      else end();
    };

    AWS.ECS.prototype.describeTasks = function(params, callback) {
      context.ecs.describeTasks.push(params);

      if (params.tasks[0] === '5452a86a162f3603a9b7b5f0d3396d40')
        return callback(new Error('pending-describe-fail'));

      if (params.tasks[0] === '5328c55acbea9eb7c23336b0718f3324')
        return callback(null, { tasks: [{ lastStatus: 'RUNNING' }] });

      if (params.tasks[0] === '9f5d92d144855210733d560d83759e11'
          || params.tasks[0] === 'e3278f8cf0a7f9b795d5f91d3739f72d'
          || params.tasks[0] === '3b80fe64b7d8278090a63a16e5908ad9')
        return callback(null, { tasks: [{ lastStatus: 'PENDING' }] });

      callback();
    };

    AWS.ECS.prototype.stopTask = function(params, callback) {
      context.ecs.stopTask.push(params);

      if (params.task === '9f5d92d144855210733d560d83759e11')
        return callback(new Error('stop-task-failure'));

      if (params.task === 'e3278f8cf0a7f9b795d5f91d3739f72d'
          || params.task === '3b80fe64b7d8278090a63a16e5908ad9')
        return callback();

      callback();
    };

    callback.call(context, assert);
  });
};

module.exports.collectionsEqual = function(assert, a, b, msg) {
  if (a.length !== b.length) return assert.deepEqual(a, b, msg);

  function stringify(item) {
    var str = JSON.stringify(item);
    str = str.replace(/\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT/g, '${date}'); // sanitize dates as strings
    return str;
  }

  var compare = b.map(stringify);
  var equal = a.map(stringify).reduce(function(equal, item) {
    if (compare.indexOf(item) === -1) return false;
    return equal;
  }, a.length === b.length);
  if (equal) assert.pass(msg);
  else assert.deepEqual(a, b, msg);
};

module.exports.expectedArn = function(message, taskDefinition, containerName, startedBy) {
  var clone = JSON.parse(JSON.stringify(message));
  clone.Attributes.ApproximateReceiveCount = clone.Attributes.ApproximateReceiveCount + 1;
  var env = messageToEnv(clone);
  var params = envToRunTaskParams(env, taskDefinition, containerName, startedBy);
  return crypto.createHash('md5').update(JSON.stringify(params)).digest('hex');
};
