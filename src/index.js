require('dotenv').config();
const axios = require('axios');
const HDWalletProvider = require('@truffle/hdwallet-provider');
const Web3 = require('web3');
const log = require('./log');
const NexusContractLoader = require('./nexus-contract-loader');
const { hex, sleep, getEnv } = require('./utils');

const GWEI_IN_WEI = 10e9;

async function getGasPrice () {
  try {
    const response = await axios.get('https://www.etherchain.org/api/gasPriceOracle');
    if (!response.data.fast) {
      throw new Error(`Failed to extract 'fast' gas value.`);
    }
    return (parseInt(response.data.fast) * GWEI_IN_WEI).toString();
  } catch (e) {
    log.warn(`Failed to get gas price from etherchain: ${e.stack} Using fallback with ethgasstation..`);
    const response = await axios.get('https://ethgasstation.info/json/ethgasAPI.json');
    if (!response.data.fast) {
      throw new Error(`Failed to extract 'fast' gas value.`);
    }
      return Math.floor((response.data.fast / 10) * GWEI_IN_WEI).toString();
  }
}

async function init () {

  const PRIVATE_KEY = getEnv(`PRIVATE_KEY`);
  const PROVIDER_URL = getEnv(`PROVIDER_URL`);
  const POLL_INTERVAL_MILLIS = parseInt(getEnv(`POLL_INTERVAL_MILLIS`));
  const DEFAULT_ITERATIONS = parseInt(getEnv(`DEFAULT_ITERATIONS`));
  const MAX_GAS = parseInt(getEnv(`MAX_GAS`));
  const MAX_GAS_PRICE = parseInt(getEnv(`MAX_GAS_PRICE`));
  const CHAIN_NAME = getEnv('CHAIN_NAME', 'mainnet');


  log.info(`Connecting to node at ${PROVIDER_URL}.`);
  const web3 = new Web3(PROVIDER_URL);
  await web3.eth.net.isListening();
  const provider = new HDWalletProvider(PRIVATE_KEY, PROVIDER_URL);

  const [address] = provider.getAddresses();

  const startBalance = await web3.eth.getBalance(address);
  log.info(`Using first address ${address} for sending transactions. Current ETH balance: ${startBalance}`);

  const versionDataURL = 'https://api.nexusmutual.io/version-data/data.json';
  log.info(`Loading latest master address for chain ${CHAIN_NAME} from ${versionDataURL}`);

  const nexusContractLoader = new NexusContractLoader(CHAIN_NAME, versionDataURL, provider, address);
  await nexusContractLoader.init();
  const pooledStaking = nexusContractLoader.instance('PS');

  while (true) {
    try {
      const hasPendingActions = await pooledStaking.hasPendingActions();
      if (!hasPendingActions) {
        log.info(`No pending actions present. Sleeping for ${POLL_INTERVAL_MILLIS} before checking again.`);
        await sleep(POLL_INTERVAL_MILLIS);
        continue;
      }
      log.info(`Has pending actions. Processing..`);

      const { gasEstimate, iterations } = await getGasEstimateAndIterations(pooledStaking, DEFAULT_ITERATIONS, MAX_GAS);
      const gasPrice = await getGasPrice();

      if (gasPrice > MAX_GAS_PRICE) {
        log.warn(`Gas price ${gasPrice} exceeds MAX_GAS_PRICE=${MAX_GAS_PRICE}. Not executing the the transaction at this time.`);
        await sleep(POLL_INTERVAL_MILLIS);
        continue;
      }
      const increasedGasEstimate = Math.floor(gasEstimate * 1.1);
      const nonce = await web3.eth.getTransactionCount(address);
      log.info(JSON.stringify({ iterations, gasEstimate, increasedGasEstimate, gasPrice, nonce }));
      const tx = await pooledStaking.processPendingActions(iterations, {
        gas: increasedGasEstimate,
        gasPrice,
        nonce
      });
      log.info(`Gas used: ${tx.receipt.gasUsed}.`);
    } catch (e) {
      log.error(`Failed to handle pending actions: ${e.stack}`);
      await sleep(POLL_INTERVAL_MILLIS);
    }
  }
}

async function getGasEstimateAndIterations(pooledStaking, defaultIterations, maxGas) {
  let iterations = defaultIterations;
  let gasEstimate;
  while (true) {
    try {
      log.info(`Estimating gas for iterations=${iterations} and maxGas=${maxGas}`);
      gasEstimate = await pooledStaking.processPendingActions.estimateGas(iterations, { gas: maxGas });
    } catch (e) {
      if (e.message.includes('base fee exceeds gas limit')) {
        log.info(`Gas estimate of ${gasEstimate} exceeds MAX_GAS=${maxGas}. Halving iterations amount..`);
        iterations = Math.floor(iterations / 2);
        continue;
      } else {
        throw e;
      }
    }

    return {
      gasEstimate,
      iterations
    }
  }
}

init()
  .catch(error => {
    log.error(`Unhandled app error: ${error.stack}`);
    process.exit(1);
  });
