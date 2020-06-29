require('dotenv').config();
const { setupLoader } = require('@openzeppelin/contract-loader');
const axios = require('axios');
const HDWalletProvider = require('@truffle/hdwallet-provider');
const log = require('./log');
const Web3 = require('web3');
const { hex, sleep, getEnv } = require('./utils');

const PENDING_ACTIONS_PROCESSED_EVENT = 'PendingActionsProcessed';

const GWEI_IN_WEI = 10e9;
const GAS_ESTIMATE_PERCENTAGE_INCREASE = 10;

async function getGasPrice () {
  try {
    const response = await axios.get('https://www.etherchain.org/api/gasPriceOracle');
    if (!response.data.fast) {
      throw new Error(`Failed to extract 'fast' gas value.`);
    }
    return (parseInt(response.data.fast) * GWEI_IN_WEI).toString();
  } catch (e) {
    log.warn(`Failed to get gas price from etherchain. Using fallback with ethgasstation..`);
    const response = await axios.get('https://ethgasstation.info/json/ethgasAPI.json');
    if (!response.data.fast) {
      throw new Error(`Failed to extract 'fast' gas value.`);
    }
    return Math.floor((response.data.fast / 10) * GWEI_IN_WEI).toString();
  }
}

function getContractData (name, versionData) {
  return versionData.mainnet.abis.filter(abi => abi.code === name)[0];
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

  const loader = setupLoader({
    provider,
    defaultSender: address,
    defaultGas: 1e6, // 1 million
    defaultGasPrice: 5e9, // 5 gwei
  }).truffle;

  const versionDataURL = 'https://api.nexusmutual.io/version-data/data.json';
  log.info(`Loading latest master address for chain ${CHAIN_NAME} from ${versionDataURL}`);
  const { data: versionData } = await axios.get(versionDataURL);

  getContractData('NXMASTER', versionData).address = process.env.MASTER_ADDRESS;
  versionData[CHAIN_NAME].abis.push({
    code: 'PS',
    contractAbi: process.env.POOLED_STAKING_ABI
  });

  const masterVersionData = getContractData('NXMASTER', versionData);
  const masterAddress = masterVersionData.address;
  log.info(`Using NXMaster at address: ${masterAddress}`);

  const master = loader.fromABI(JSON.parse(masterVersionData.contractAbi), null, masterAddress);
  const psAddress = await master.getLatestAddress(hex('PS'));

  const pooledStakingVersionData = getContractData('PS', versionData);
  log.info(`Using PooledStaking at: ${psAddress}`);
  const pooledStakingABI = pooledStakingVersionData.contractAbi;

  const pooledStaking = loader.fromABI(JSON.parse(pooledStakingABI), null, psAddress);

  let hasPendingActions = await pooledStaking.hasPendingActions();
  while (true) {
    try {
      if (!hasPendingActions) {
        log.info(`No pending actions present. Sleeping for ${POLL_INTERVAL_MILLIS} before checking again.`);
        await sleep(POLL_INTERVAL_MILLIS);
        hasPendingActions = await pooledStaking.hasPendingActions();
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
      const increasedGasEstimate = Math.floor(gasEstimate * (GAS_ESTIMATE_PERCENTAGE_INCREASE + 100) / 100);
      const nonce = await web3.eth.getTransactionCount(address);
      log.info(JSON.stringify({ iterations, gasEstimate, increasedGasEstimate, gasPrice, nonce }));
      const tx = await pooledStaking.processPendingActions(iterations, {
        gas: increasedGasEstimate,
        gasPrice,
        nonce
      });
      log.info(`Gas used: ${tx.receipt.gasUsed}.`);

      const [pendingActionsEvent] = tx.logs.filter(log => log.event === PENDING_ACTIONS_PROCESSED_EVENT);
      if (!pendingActionsEvent) {
        log.error(`Unexpected: ${PENDING_ACTIONS_PROCESSED_EVENT} event could not be found.`);
      } else {
        log.info(`${PENDING_ACTIONS_PROCESSED_EVENT}.finished = ${pendingActionsEvent.args.finished}`);
        hasPendingActions = !pendingActionsEvent.args.finished;
      }

    } catch (e) {
      log.error(`Failed to handle pending actions: ${e.stack}`);
      await sleep(POLL_INTERVAL_MILLIS);
      hasPendingActions = await pooledStaking.hasPendingActions();
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
        log.info(`Gas estimate of ${gasEstimate} exceeds MAX_GAS=${maxGas}. Halfing iterations amount..`);
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
