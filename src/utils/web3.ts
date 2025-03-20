import { Keypair, VersionedTransaction, PublicKey, PartiallyDecodedInstruction } from '@solana/web3.js';
import { Metaplex, token } from '@metaplex-foundation/js';
import { Wallet } from '@project-serum/anchor';
import { UserType } from '../models/user.model';
import { TokenInfoType } from '../config/types';
import { User } from '../models/user.model';
import {
  connection,
  bot,
  INSTRUCTION_NAME,
  RAYDIUM,
  SOL_ADDRESS,
  sigHistory,
  RAYDIUM_PUBLIC_KEY,
  SOL_DECIMAL,
} from '../config/config';
import { uint8ArrayToHex, sendMessageToAllActiveUsers, addItemToArray } from './functions';
import { sendBundle } from './jito';
import { getQuoteForSwap, getSerializedTransaction, getTokenPrice } from './jupiter';
import bs58 from 'bs58';

//-------------------------------------------------------------------------------------------------------------+
//                                            Define the functions                                             |
//-------------------------------------------------------------------------------------------------------------+

/**
 * Get token metadata from its address
 * @param {string} mintAddress
 */
export async function getTokenInfo(mintAddress: string) {
  const metaplex = Metaplex.make(connection);

  const mint = new PublicKey(mintAddress);

  try {
    const tokenMetadata = await metaplex.nfts().findByMint({ mintAddress: mint });
    const price = await getTokenPrice(mintAddress);
    console.log(
      'token metadata:',
      tokenMetadata,
      tokenMetadata.mint.freezeAuthorityAddress,
      tokenMetadata.mint.supply.basisPoints,
      price
    );
    const risk = tokenMetadata.mint.freezeAuthorityAddress ? 100 : tokenMetadata.mint.mintAuthorityAddress ? 50 : 0;
    return {
      name: tokenMetadata.name,
      symbol: tokenMetadata.symbol,
      address: tokenMetadata.address.toString(),
      decimals: tokenMetadata.mint.decimals,
      risk,
      price,
      //   currentSupply: tokenMetadata.mint.supply.basisPoints.toNumber(),
    };
  } catch (error) {
    console.error('Error fetching token metadata:', error);
  }
}
// getTokenInfo('66tKSYiL1NjvSKra9AQDHKjsRQugidztqsVcuoxS1gLd');

/**
 * Get the SOL balance of wallet
 * @param {string} walletAddress Wallet address for which you want to know the balance of SOL
 * @returns SOL balance of wallet
 */
export async function getBalanceOfWallet(walletAddress: string) {
  try {
    const balance = await connection.getBalance(new PublicKey(walletAddress));
    // console.log('SOL balance:', balance / SOL_DECIMAL);
    return balance;
  } catch (error) {
    console.error('Error while getBalanceOfWallet', error);
    return 0;
  }
}

/**
 * Get token balance of wallet
 * @param {string} walletAddr Wallet address for which you want to know the token balance
 * @param {string} tokenAddr Token address you want to know the balance
 * @returns
 */
export async function getTokenBalanceOfWallet(walletAddr: string, tokenAddr: string) {
  try {
    const info = await connection.getParsedTokenAccountsByOwner(new PublicKey(walletAddr), {
      mint: new PublicKey(tokenAddr),
    });
    const tokenInfo = info?.value[0]?.account?.data.parsed.info.tokenAmount;
    console.log('token balance:', tokenInfo);
    // return balance;
    return Number(tokenInfo?.amount);
  } catch (error) {
    console.error('Error while getBalanceOfWallet', error);
    return 0;
  }
}
// getTokenBalanceOfWallet('5cXuJnqZ2EfDmyD49WjLKoHcrfdVDJLcRcMaaN5XJV6N', '4vnxfs93abESD2ZTtA6VJ3HgcLMrba7NXQDL7asTpump')

/**
 * Listen 'initialize2' instruction
 */
export async function monitorNewToken() {
  console.log('Monitoring new Token...');
  try {
    await connection.onLogs(
      RAYDIUM,
      ({ logs, err, signature }) => {
        if (err) {
          return;
        }
        if (logs && logs.some((log) => log.includes(INSTRUCTION_NAME))) {
          if (sigHistory.includes(signature)) {
            return;
          }
          addItemToArray(signature, sigHistory);
          console.log("Signature for 'initialize2':", `https://explorer.solana.com/tx/${signature}`);
          fetchRaydiumMints(signature);
        }
      },
      'finalized'
    );
  } catch (error) {
    console.error('Error while monitorNewToken:', error);
  }
}

/**
 * Get the newly added liqudity token and send message to users
 * @param {string} txId
 * @returns
 */
export async function fetchRaydiumMints(txId: string) {
  try {
    const tx = await connection.getParsedTransaction(txId, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });

    const accounts = (
      tx?.transaction?.message?.instructions.find(
        (ix) => ix.programId.toBase58() == RAYDIUM_PUBLIC_KEY
      ) as PartiallyDecodedInstruction
    )?.accounts;

    if (!accounts) {
      return;
    }

    const tokens = [];
    tokens.push(accounts[8].toBase58());
    tokens.push(accounts[9].toBase58());
    const poolAddress = accounts[4].toBase58();
    console.log('poolAddressL', poolAddress);

    if (tokens.some((token) => token === SOL_ADDRESS) === false) {
      return;
    }

    const token = tokens.find((token) => token !== SOL_ADDRESS);
    if (!token) {
      return;
    }

    const tokenInfo = await getTokenInfo(token);
    if (!tokenInfo) {
      return;
    }
    if (tokenInfo?.risk === 100) {
      console.log('High risk token.');
      throw new Error('High risk: It is a freezeable token.');
    }

    console.log('New LP Found', tokenInfo);
  } catch (error: any) {
    if (error?.message) {
      console.log(txId, '=====', error?.message);
    } else {
      console.error('Error fetching transaction:', txId, error);
    }
    // return;
  }
}

/**
 * Generate new Solana wallet.
 * @returns Return object of publicKey and privateKey
 */
export const generateWallet = async () => {
  try {
    const keyPair = Keypair.generate(); // Generate new key pair of publicKey and privateKey
    return {
      publicKey: keyPair.publicKey.toString(),
      privateKey: uint8ArrayToHex(keyPair.secretKey),
    };
  } catch (error) {
    console.error('Error while generating wallet:', error);
    throw new Error('Failed to generate new Solana wallet.');
  }
};

export const generateWalletFromKey = async (privateKey: string) => {
  try {
    const uint8Array = bs58.decode(privateKey);
    const keyPair = Keypair.fromSecretKey(uint8Array);
    return {
      publicKey: keyPair.publicKey.toString(),
      privateKey: uint8ArrayToHex(keyPair.secretKey),
    };
  } catch (error) {
    console.error(error);
  }
};

/**
 *
 * @param {string} swapTransaction
 * @returns
 */
export async function getDeserialize(swapTransaction: string) {
  try {
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    return transaction;
  } catch (error) {
    console.error('Error while getDeserialize:', error);
    throw new Error('Error while getDeserialize');
  }
}

/**
 * Sign transaction with keyPair
 * @param {VersionedTransaction} transaction
 * @param {Keypair} keyPair
 * @returns
 */
export async function signTransaction(transaction: VersionedTransaction, keyPair: Keypair) {
  try {
    transaction.sign([keyPair]);
    return transaction;
  } catch (error) {
    console.error('Error while signTransaction:', error);
    throw new Error('Error while signTransaction');
  }
}

/**
 *
 * @param {VersionedTransaction} transaction
 * @param {string} secretKey
 * @returns
 */
export async function executeTransaction(transaction: VersionedTransaction) {
  try {
    const latestBlockHash = await connection.getLatestBlockhash();

    const rawTransaction = transaction.serialize();
    const txId = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
    });

    console.log('txid:', txId);
    await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: txId,
    });

    return { success: true, txId };
  } catch (error) {
    console.error('Error while executeTransaction:', error);
    return { success: false, txId: '' };
  }
}

/**
 * Buy outputAddr token with inputAddr token for amount using jupiter API and jito.
 * @param {string} inputAddr The token address you want to buy
 * @param {string} outputAddr The token address you want to buy
 * @param {number} amount The token amount you want to buy
 * @param {string} secretKey The secretKey of wallet you want to use to buy and pay for jito fee
 * @param {number} jitoFee Jitofee for usage of jito bundles
 */
export async function swapTokens(
  inputAddr: string,
  outputAddr: string,
  amount: number,
  secretKey: string,
  jitoFee: number,
  slippageBps: number,
  dexId: string
) {
  try {
    const keyPair = Keypair.fromSecretKey(Buffer.from(secretKey, 'hex'));
    const prevSolAmount = await getBalanceOfWallet(keyPair.publicKey.toString());
    console.log('prevSol:', prevSolAmount, keyPair.publicKey);

    // if (dexId === 'meteora' || dexId === 'raydium') {
    // Get quote for swap using Jupiter API
    const quote = await getQuoteForSwap(inputAddr, outputAddr, amount, slippageBps);
    // Get swap transaction using Jupiter API
    const swapTransaction = await getSerializedTransaction(quote, keyPair.publicKey.toString());
    // Deserialize the transaction
    const transaction = await getDeserialize(swapTransaction);
    // Sign the transaction
    const signedTransaction = await signTransaction(transaction, keyPair);
    console.log('signedTransaction:', signedTransaction);
    // Bundle the transaction
    // const result = await sendBundle([signedTransaction], keyPair, jitoFee);
    // console.log('sendBundle result:', result);
    // Execute the transaction
    const result = await executeTransaction(signedTransaction);
    console.log('Swap Result:', result);
    if (result.success) {
      const solDiff = await getTransactionDetails(result.txId);
      const tokenBalance = await getTokenBalanceOfWallet(keyPair.publicKey.toString(), inputAddr);
      return {
        success: true,
        txId: result.txId,
        outAmount: tokenBalance || Number(quote.outAmount),
        solDiff: solDiff || 0,
      };
    } else {
      return { success: false, solDiff: 0 };
    }
    // }
    return { success: false, solDiff: 0 };
  } catch (error) {
    console.error('Error while swapTransaction:', error);
    throw new Error('Error while swapTransaction');
  }
}

async function getTransactionDetails(txid: string) {
  const transactionDetails = await connection.getParsedTransaction(txid, { maxSupportedTransactionVersion: 0 });
  console.log(transactionDetails);

  if (transactionDetails && transactionDetails.meta) {
    const preBalances = transactionDetails.meta.preBalances;
    const postBalances = transactionDetails.meta.postBalances;

    // Assuming your wallet is at index 0 in preBalances and postBalances
    const solReceived = (postBalances[0] - preBalances[0]) / SOL_DECIMAL;

    console.log(`SOL Received: ${solReceived}`);
    return Math.abs(solReceived);
  } else {
    console.error('Transaction details not found');
    return null;
  }
}
