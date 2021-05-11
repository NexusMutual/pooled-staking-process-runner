const fetch = require('node-fetch');
const log = require('./log');
const { to } = require('./utils');

const SPEED = {
  SAFE_LOW: 'safeLow',
  STANDARD: 'standard',
  ABOVE_STANDARD: 'aboveStandard',
  FAST: 'fast',
  FASTEST: 'fastest',
};

const GWEI_IN_WEI = 1e9;
const ETHERCHAIN_URL = 'https://www.etherchain.org/api/gasPriceOracle';
const ETHGASSTATION_URL = 'https://ethgasstation.info/json/ethgasAPI.json';

/**
 * Fetches gas prices from Etherchain with fallback to EthGasStation if the first fails
 * @return {Promise<{standard: number, fast: number, fastest: number, safeLow: number}>}
 */
const fetchGasPrices = async () => {

  const [{ data: gasNowPrice, code }, ecError] = await to(fetch(GASNOW_URL).then(r => r.json()));

  if (!ecError && code === 200) {
    return {
      fastest: gasNowPrice.rapid / GWEI_IN_WEI,
      fast: gasNowPrice.fast / GWEI_IN_WEI,
      standard: gasNowPrice.standard / GWEI_IN_WEI,
      safeLow: gasNowPrice.slow / GWEI_IN_WEI,
    };
  }

  log.error(`Failed to fetch GasNow price data, using EthGasStation as a fallback: ${ecError.stack} ${code} ${gasNowPrice}`);

  const [egsPrice, egsError] = await to(fetch(ETHGASSTATION_URL).then(r => r.json()));

  if (egsError) {
    log.error(`Failed to fetch EthGasStation: ${egsError.stack}`);
    throw new Error('Gas price fetching failed');
  }

  return {
    fastest: egsPrice.fastest / 10,
    fast: egsPrice.fast / 10,
    standard: egsPrice.average / 10,
    safeLow: egsPrice.safeLow / 10,
  };
};

/**
 * Returns a recommended gas price considering the requested speed and upper limit
 * @param speed {string}
 * @return {Promise<number>}
 */
const getGasPrice = async (speed) => {
  const prices = await fetchGasPrices();
  prices[SPEED.ABOVE_STANDARD] = getAboveStandardPrice(prices);
  log.info(JSON.stringify(prices));
  const { [speed]: price } = prices;

  if (!price) {
    throw new Error(`No gas price found for '${speed}' speed`);
  }

  return Math.round(price * GWEI_IN_WEI);
};

function getAboveStandardPrice (prices) {
  return Math.floor((prices.fast + prices.standard)) / 2;
}

module.exports = {
  getGasPrice,
  SPEED,
};
