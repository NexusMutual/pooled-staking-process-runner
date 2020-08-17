const fetch = require('node-fetch');
const log = require('./log');

const ETHERCHAIN_GAS_API_URL = 'https://www.etherchain.org/api/gasPriceOracle';
const ETHGASSTATION_GAS_API_URL = 'https://ethgasstation.info/json/ethgasAPI.json';

const PRICE_LEVEL = {
  SAFE_LOW: 'safeLow',
  STANDARD: 'standard',
  ABOVE_STANDARD: 'aboveStandard',
  FAST: 'fast',
  FASTEST: 'fastest',
};

const GWEI_IN_WEI = 1e9;

async function getGasPrice (priceLevel) {
  let prices;
  try {
    prices = await getETHGasStationPrices();
  } catch (e) {
    log.warn(`Failed to get gas price from ethgasstation: ${e.stack} Using fallback with etherchain..`);
    prices = await getEtherchainPrices();
  }
  log.info(`Gas results: ${JSON.stringify(prices)}`);
  const price = prices[priceLevel];
  return price.toString();
}

async function getEtherchainPrices () {
  const data = await fetch(ETHERCHAIN_GAS_API_URL).then(res => res.json());
  const prices = data;
  for (const level of Object.keys(prices)) {
    prices[level] = parseInt(prices[level]) * GWEI_IN_WEI;
  }
  prices[PRICE_LEVEL.ABOVE_STANDARD] = getAboveStandardPrice(prices);
  return prices;
}

async function getETHGasStationPrices () {
  const data = await fetch(ETHGASSTATION_GAS_API_URL).then(res => res.json());
  const prices = {};
  prices[PRICE_LEVEL.SAFE_LOW] = data.safeLow / 10;
  prices[PRICE_LEVEL.STANDARD] = data.average / 10;
  prices[PRICE_LEVEL.FAST] = data.fast / 10;
  prices[PRICE_LEVEL.FASTEST] = data.fastest / 10;
  for (const level of Object.keys(prices)) {
    prices[level] = prices[level] * GWEI_IN_WEI;
  }

  prices[PRICE_LEVEL.ABOVE_STANDARD] = getAboveStandardPrice(prices);
  return prices;
}

function getAboveStandardPrice (prices) {
  return Math.floor((prices.fast + prices.standard)) / 2;
}

module.exports = {
  getGasPrice,
  PRICE_LEVEL,
};
