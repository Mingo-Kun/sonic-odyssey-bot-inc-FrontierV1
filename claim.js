const fs = require('fs');
require('colors');
const solana = require('@solana/web3.js');
const axios = require('axios').default;
const base58 = require('bs58');
const nacl = require('tweetnacl');
const { getConnection, delay, getNetType } = require('./src/solanaUtils');
const { HEADERS } = require('./src/headers');
const { displayHeader, getNetworkTypeFromUser } = require('./src/displayUtils');
const readlineSync = require('readline-sync');
const moment = require('moment');

// Load private keys from file
const PRIVATE_KEYS = JSON.parse(fs.readFileSync('privateKeys.json', 'utf-8'));

// API base URL
const apiBaseUrl = 'https://odyssey-api-beta.sonic.game';

// Connection variable
var connection;

/**
 * Get keypair from private key
 */
function getKeypair(privateKey) {
  const decodedPrivateKey = base58.decode(privateKey);
  return solana.Keypair.fromSecretKey(decodedPrivateKey);
}

/**
 * Fetch authentication token
 */
async function getToken(privateKey) {
  try {
    const { data } = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/auth/sonic/challenge',
      params: {
        wallet: getKeypair(privateKey).publicKey,
      },
      headers: HEADERS,
    });
    const sign = nacl.sign.detached(Buffer.from(data.data), getKeypair(privateKey).secretKey);
    const signature = Buffer.from(sign).toString('base64');
    const publicKey = getKeypair(privateKey).publicKey;
    const encodedPublicKey = Buffer.from(publicKey.toBytes()).toString('base64');
    const response = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/auth/sonic/authorize',
      method: 'POST',
      headers: HEADERS,
      data: {
        address: publicKey,
        address_encoded: encodedPublicKey,
        signature,
      },
    });
    return response.data.data.token;
  } catch (error) {
    console.log(`Error fetching token: ${error.response?.data?.message || error.message}`.red);
  }
}

/**
 * Fetch user profile
 */
async function getProfile(token) {
  try {
    const { data } = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/user/rewards/info',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });
    return data.data;
  } catch (error) {
    console.log(`Error fetching profile: ${error.response?.data?.message || error.message}`.red);
  }
}

/**
 * Perform Solana transactions with retry logic
 */
async function doTransactions(tx, keypair, retries = 3) {
  try {
    const bufferTransaction = tx.serialize();
    const signature = await connection.sendRawTransaction(bufferTransaction);
    await connection.confirmTransaction(signature);
    return signature;
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying transaction... (${retries} retries left)`.yellow);
      await new Promise((res) => setTimeout(res, 1000));
      return doTransactions(tx, keypair, retries - 1);
    } else {
      console.log(`Error in transaction: ${error.response?.data?.message || error.message}`.red);
      throw error;
    }
  }
}

/**
 * Open a mystery box
 */
async function openMysteryBox(token, keypair, retries = 3) {
  try {
    const { data } = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/user/rewards/mystery-box/build-tx',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });
    const txBuffer = Buffer.from(data.data.hash, 'base64');
    const tx = solana.Transaction.from(txBuffer);
    tx.partialSign(keypair);
    const signature = await doTransactions(tx, keypair);
    const response = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/user/rewards/mystery-box/open',
      method: 'POST',
      headers: { ...HEADERS, Authorization: token },
      data: {
        hash: signature,
      },
    });
    return response.data;
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying opening mystery box... (${retries} retries left)`.yellow);
      await new Promise((res) => setTimeout(res, 1000));
      return openMysteryBox(token, keypair, retries - 1);
    } else {
      console.log(`Error opening mystery box: ${error.response?.data?.message || error.message}`.red);
      throw error;
    }
  }
}

/**
 * Process each private key
 */
async function processPrivateKey(privateKey) {
  try {
    const publicKey = getKeypair(privateKey).publicKey.toBase58();
    const token = await getToken(privateKey);
    const profile = await getProfile(token);
    if (profile.wallet_balance > 0) {
      const balance = profile.wallet_balance / solana.LAMPORTS_PER_SOL;
      const ringBalance = profile.ring;
      const availableBoxes = profile.ring_monitor;
      console.log(`Hello ${publicKey}! Welcome to our bot. Here are your details:`.green);
      console.log(`Solana Balance: ${balance} SOL`.green);
      console.log(`Ring Balance: ${ringBalance}`.green);
      console.log(`Available Box(es): ${availableBoxes}`.green);
      console.log('');
      const isAutoFlow = readlineSync.question('Do you want to use auto flow? (y/n): ');
      console.log('');
      if (isAutoFlow.toLowerCase() === 'y') {
        console.log(`[ ${moment().format('HH:mm:ss')} ] Starting auto flow...`.yellow);
        await runAutoFlow(token, getKeypair(privateKey));
      } else {
        const method = readlineSync.question(
          'Select input method (1 for claim box, 2 for open box, 3 for daily login): '
        );
        console.log('');
        if (method === '1') {
          console.log(`[ ${moment().format('HH:mm:ss')} ] Claiming daily rewards...`.yellow);
          await dailyClaim(token);
          console.log(`[ ${moment().format('HH:mm:ss')} ] Daily claim completed!`.cyan);
        } else if (method === '2') {
          let totalClaim;
          do {
            totalClaim = readlineSync.question(
              `How many boxes do you want to open? (Maximum is: ${availableBoxes}): `.blue
            );
            if (totalClaim > availableBoxes) {
              console.log(`You cannot open more boxes than available`.red);
            } else if (isNaN(totalClaim)) {
              console.log(`Please enter a valid number`.red);
            } else {
              console.log(`[ ${moment().format('HH:mm:ss')} ] Opening boxes...`.yellow);
              await openMultipleBoxes(token, getKeypair(privateKey), totalClaim);
              console.log(`[ ${moment().format('HH:mm:ss')} ] Box opening completed!`.cyan);
            }
          } while (totalClaim > availableBoxes);
        } else if (method === '3') {
          console.log(`[ ${moment().format('HH:mm:ss')} ] Performing daily login...`.yellow);
          await dailyLogin(token, getKeypair(privateKey));
          console.log(`[ ${moment().format('HH:mm:ss')} ] Daily login completed!`.cyan);
        } else {
          throw new Error('Invalid input method selected'.red);
        }
      }
    } else {
      console.log(
        `There might be errors if you don't have sufficient balance or the RPC is down. Please ensure your balance is sufficient and your connection is stable`
          .red
      );
    }
  } catch (error) {
    console.log(`Error processing private key: ${error.response?.data?.message || error.message}`.red);
  }
  console.log('');
}

/**
 * Fetch daily transactions
 */
async function fetchDaily(token) {
  try {
    const { data } = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/user/transactions/state/daily',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });
    return data.data.total_transactions;
  } catch (error) {
    console.log(
      `[ ${moment().format('HH:mm:ss')} ] Error in daily fetching: ${
        error.response?.data?.message || error.message
      }`.red
    );
  }
}

/**
 * Claim daily rewards
 */
async function dailyClaim(token) {
  let counter = 1;
  const maxCounter = 3;
  try {
    const fetchDailyResponse = await fetchDaily(token);
    console.log(
      `[ ${moment().format('HH:mm:ss')} ] Your total transactions: ${fetchDailyResponse}`.blue
    );
    if (fetchDailyResponse > 10) {
      while (counter <= maxCounter) {
        try {
          const { data } = await axios({
            url:
              apiBaseUrl +
              (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
              '/user/transactions/rewards/claim',
            method: 'POST',
            headers: { ...HEADERS, Authorization: token },
            data: {
              stage: counter,
            },
          });
          console.log(
            `[ ${moment().format('HH:mm:ss')} ] Daily claim for stage ${counter} has been successful! Stage: ${counter} | Status: ${
              data.data.claimed
            }`.green
          );
          counter++;
        } catch (error) {
          if (error.response && error.response.data.message === 'interact task not finished') {
            console.log(
              `[ ${moment().format('HH:mm:ss')} ] Error claiming for stage ${counter}: ${
                error.response.data.message
              }`.red
            );
            counter++;
          } else if (
            error.response &&
            (error.response.data.code === 100015 || error.response.data.code === 100016)
          ) {
            console.log(
              `[ ${moment().format('HH:mm:ss')} ] Already claimed for stage ${counter}, proceeding to the next stage...`.cyan
            );
            counter++;
          } else {
            console.log(
              `[ ${moment().format('HH:mm:ss')} ] Error claiming: ${
                error.response?.data?.message || error.message
              }`.red
            );
          }
        } finally {
          await delay(1000);
        }
      }
      console.log(`All stages processed or max stage reached.`.green);
    } else {
      throw new Error('Not enough transactions to claim rewards.');
    }
  } catch (error) {
    console.log(
      `[ ${moment().format('HH:mm:ss')} ] Error in daily claim: ${
        error.response?.data?.message || error.message
      }`.red
    );
  }
}

/**
 * Perform daily login
 */
async function dailyLogin(token, keypair) {
  try {
    const { data } = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/user/check-in/transaction',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });
    const txBuffer = Buffer.from(data.data.hash, 'base64');
    const tx = solana.Transaction.from(txBuffer);
    tx.partialSign(keypair);
    const signature = await doTransactions(tx, keypair);
    const response = await axios({
      url:
        apiBaseUrl +
        (getNetType() == 3 ? '/testnet-v1' : getNetType() == 2 ? '/testnet' : '') +
        '/user/check-in',
      method: 'POST',
      headers: { ...HEADERS, Authorization: token },
      data: {
        hash: signature,
      },
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.data.message === 'current account already checked in') {
      console.log(
        `[ ${moment().format('HH:mm:ss')} ] Error in daily login: ${
          error.response.data.message
        }`.red
      );
    } else {
      console.log(
        `[ ${moment().format('HH:mm:ss')} ] Error claiming: ${
          error.response?.data?.message || error.message
        }`.red
      );
    }
  }
}

/**
 * Open multiple boxes
 */
async function openMultipleBoxes(token, keypair, totalClaim) {
  for (let i = 0; i < totalClaim; i++) {
    const openedBox = await openMysteryBox(token, keypair);
    if (openedBox.data.success) {
      console.log(
        `[ ${moment().format('HH:mm:ss')} ] Box opened successfully! Status: ${
          openedBox.status
        } | Amount: ${openedBox.data.amount}`.green
      );
    } else {
      console.log(`[ ${moment().format('HH:mm:ss')} ] All boxes have been opened.`.red);
    }
  }
}

/**
 * Run auto flow (daily login, claim, and open boxes)
 */
async function runAutoFlow(token, keypair) {
  while (true) {
    try {
      await dailyLogin(token, keypair);
      await dailyClaim(token);
      const availableBoxes = (await getProfile(token)).ring_monitor;
      await openMultipleBoxes(token, keypair, availableBoxes);
      console.log(`[ ${moment().format('HH:mm:ss')} ] Auto flow completed!`.cyan);
    } catch (error) {
      console.log(`[ ${moment().format('HH:mm:ss')} ] Error in auto flow: ${error.response?.data?.message || error.message}`.red);
    }
    console.log(`\n[ ${moment().format('HH:mm:ss')} ] Waiting 12 hours before next run...`.yellow);
    await delay(12 * 60 * 60 * 1000);
  }
}

/**
 * Main execution
 */
(async () => {
  try {
    displayHeader();
    // Initialize the network (calls setNetType internally)
    await getNetworkTypeFromUser();
    connection = getConnection();
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const privateKey = PRIVATE_KEYS[i];
      await processPrivateKey(privateKey);
    }
    console.log('All private keys processed.'.cyan);
  } catch (error) {
    console.log(`Error in bot operation: ${error.response?.data?.message || error.message}`.red);
  } finally {
    console.log('Thanks for having us! Subscribe: https://t.me/HappyCuanAirdrop'.magenta);
  }
})();

