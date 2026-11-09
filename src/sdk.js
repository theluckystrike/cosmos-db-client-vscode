'use strict';
// The Azure Cosmos DB SDK (MIT) and the HTTP client it uses, bundled into dist/sdk.js on its own.
// extension.js loads this file only when the user connects, so activation stays fast.
const cosmos = require('@azure/cosmos');
const { createDefaultHttpClient } = require('@azure/core-rest-pipeline');

module.exports = {
  CosmosClient: cosmos.CosmosClient,
  BulkOperationType: cosmos.BulkOperationType,
  NonePartitionKeyValue: cosmos.NonePartitionKeyValue,
  PartitionKeyKind: cosmos.PartitionKeyKind,
  createDefaultHttpClient,
};
