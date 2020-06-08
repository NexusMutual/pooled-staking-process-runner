require('dotenv').config();
const { setupLoader } = require('@openzeppelin/contract-loader');
const axios = require('axios');
const HDWalletProvider = require('@truffle/hdwallet-provider');
const Wallet = require('ethereumjs-wallet');
const EthUtil = require('ethereumjs-util');
const log = require('./log');

const PENDING_ACTIONS_PROCESSED_EVENT = 'PendingActionsProcessed';

function getEnv (key, fallback = false) {

  const value = process.env[key] || fallback;

  if (!value) {
    throw new Error(`Missing env var: ${key}`);
  }

  return value;
}

const GWEI_IN_WEI = 10 ** 9;

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

function getAddressFromPrivatKey (privateKey) {
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

  const provider = new HDWalletProvider(privateKey, providerURL);

  console.log(`private key ${privateKey}`);
  const address = getAddressFromPrivatKey(privateKey);
  console.log(`Public address: ${address}`);

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
      if (hasPendingActions) {
        log.info(`Has pending actions. Processing..`);
        const [gasEstimate, gasPrice] = await Promise.all([
          pooledStaking.processPendingActions.estimateGas({ gas: 1e9 }),
          getGasPrice(),
        ]);
        const tx = await pooledStaking.processPendingActions({
          gas: gasEstimate,
          gasPrice,
        });
        log.info(`gasEstimate: ${gasEstimate}, gasPrice: ${gasPrice}`);
        const pendingActionsEvent = tx.logs.filter(log => log.event === PENDING_ACTIONS_PROCESSED_EVENT)[0];
        if (!pendingActionsEvent) {
          log.error(`Unexpected: ${PENDING_ACTIONS_PROCESSED_EVENT} event could not be found.`);
        } else {
          log.info(`${PENDING_ACTIONS_PROCESSED_EVENT}.finished = ${pendingActionsEvent.args.finished}`);
          hasPendingActions = !pendingActionsEvent.args.finished;
        }
      } else {
        log.info(`No pending actions present. Sleeping for ${pollInterval} before checking again.`);
        await sleep(pollInterval);
        hasPendingActions = await pooledStaking.hasPendingActions();
      }
    } catch (e) {
      log.error(`Failed to handle pending actions: ${e.stack}`);
      await sleep(pollInterval);
      hasPendingActions = await pooledStaking.hasPendingActions();
    }
  }

}

init()
  .catch(error => {
    log.error(`Unhandled app error: ${error.stack}`);
    process.exit(1);
  });
