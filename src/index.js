require('dotenv').config();
const { setupLoader } = require('@openzeppelin/contract-loader');
const axios = require('axios');
const HDWalletProvider = require('@truffle/hdwallet-provider');
const Wallet = require('ethereumjs-wallet');
const EthUtil = require('ethereumjs-util');
const log = require('./log');
const Web3 = require('web3');

const PENDING_ACTIONS_PROCESSED_EVENT = 'PendingActionsProcessed';

function getEnv (key, fallback = false) {

  const value = process.env[key] || fallback;

  if (!value) {
    throw new Error(`Missing env var: ${key}`);
  }

  return value;
}

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

function getAddressFromPrivateKey (privateKey) {
  const privateKeyBuffer = EthUtil.toBuffer(privateKey);
  const wallet = Wallet.fromPrivateKey(privateKeyBuffer);
  return wallet.getAddressString();
}

const hex = string => '0x' + Buffer.from(string).toString('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function getContractData (name, versionData) {
  return versionData.mainnet.abis.filter(abi => abi.code === name)[0];
}

async function init () {

  const privateKey = getEnv(`PRIVATE_KEY`);
  const providerURL = getEnv(`PROVIDER_URL`);
  const pollInterval = parseInt(getEnv(`POLL_INTERVAL_MILLIS`));
  const defaultIterations = parseInt(getEnv(`DEFAULT_ITERATIONS`));
  const maxGas = parseInt(getEnv(`MAX_GAS`));

  const provider = new HDWalletProvider(privateKey, providerURL);

  const address = getAddressFromPrivateKey(privateKey);

  const web3 = new Web3(providerURL);
  const loader = setupLoader({
    provider,
    defaultSender: address,
    defaultGas: 1e6, // 1 million
    defaultGasPrice: 5e9, // 5 gwei
  }).truffle;

  const versionDataURL = 'https://api.nexusmutual.io/version-data/data.json';
  log.info(`Loading latest master address from ${versionDataURL}`);
  const { data: versionData } = await axios.get(versionDataURL);

  const masterVersionData = getContractData('NXMASTER', versionData);
  const masterAddress = getEnv(`MASTER_ADDRESS`, masterVersionData.address);
  log.info(`Using NXMaster at address: ${masterAddress}`);

  const master = loader.fromABI(JSON.parse(masterVersionData.contractAbi), null, masterAddress);
  const psAddress = await master.getLatestAddress(hex('PS'));

  const pooledStakingVersionData = getContractData('PS', versionData);
  log.info(`Using PooledStaking at: ${psAddress}`);
  const pooledStakingABI = pooledStakingVersionData ? pooledStakingVersionData.contractABI : getEnv('POOLED_STAKING_ABI');

  const pooledStaking = loader.fromABI(JSON.parse(pooledStakingABI), null, psAddress);

  let hasPendingActions = await pooledStaking.hasPendingActions();
  while (true) {
    try {
      if (!hasPendingActions) {
        log.info(`No pending actions present. Sleeping for ${pollInterval} before checking again.`);
        await sleep(pollInterval);
        hasPendingActions = await pooledStaking.hasPendingActions();
        continue;
      }
      log.info(`Has pending actions. Processing..`);

      const { gasEstimate, iterations } = await getGasEstimateAndIterations(pooledStaking, defaultIterations, maxGas);
      const gasPrice = await getGasPrice();

      const increasedGasEstimate = Math.floor(gasEstimate * (GAS_ESTIMATE_PERCENTAGE_INCREASE + 100) / 100);
      log.info(`gasEstimate: ${gasEstimate} | increasedGasEstimate ${increasedGasEstimate} | gasPrice: ${gasPrice}`);
      const nonce = await web3.eth.getTransactionCount(address);
      log.info(`Nonce to be used: ${nonce}`);
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
      await sleep(pollInterval);
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
