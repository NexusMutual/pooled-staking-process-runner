# pooled-staking-process-runner

Runs on a continous basis to call the `.processPendingActions` method of the PooledStaking.sol contract to 
ensure all pooled staking actions (stakes, burns, rewards) are processed.

## Setup and run

### Configuration

Setup your environment variables as shown in the provided `.env.sample` file.

| Option name | Description |
| ------------- |:-------------:|
| PRIVATE_KEY | Ethereum address private key containing ETH funds to spend on gas.
| PROVIDER_URL | Provider URL used by Web3. |
| POLL_INTERVAL_MILLIS | Polling interval to check if there are pending intervals. |
| DEFAULT_ITERATIONS | Default number of iterations used by processPendingActions |
| MAX_GAS | How much gas to use at most. If it is exceeded, the number of used iterations is halved. | 


### Running
```$xslt
npm i
npm start
```
