import dotenv from 'dotenv';
dotenv.config({
  path: './.env',
});

import { SOL_ADDRESS, SOL_DECIMAL, bot } from './config/config';
import { User } from './models/user.model';
import { checkTimeFormat } from './utils/functions';
import { settingText } from './models/text.model';
import { settingMarkUp } from './models/markup.model';
import { checkAction } from './utils/middleware';
import { startCommand, helpCommand, settingCommand } from './commands/commands';
import { generateWalletFromKey, getBalanceOfWallet, swapTokens } from './utils/web3';
import { getTokenPriceOnRaydium, getTokenPriceUsingDexScreener } from './utils/price';
import { tokens } from './config/tokens';
import { TokenDataType } from './config/types';
import { settingAction, closeAction, returnAction, helpAction } from './actions/general.action';
import { walletAction, onOffAction, inputAction, importWalletAction } from './actions/setting.action';
// import { main } from './utils/bitquery';
// main();

//-------------------------------------------------------------------------------------------------------------+
//                                             Set the commands                                                |
//-------------------------------------------------------------------------------------------------------------+

bot.command('arbitrage', async (ctx) => {
  const tgId = ctx.chat.id;
  try {
    const user = await User.findOne({ tgId });
    if (!user) {
      ctx.reply('I can not find you. Please input /start command to let me verify you.');
      return;
    }
    if (!user?.wallet) {
      ctx.reply('Please enter private key you want to use for trade. Then try again.');
    }
    // Looping all tokens
    await Promise.all(
      tokens.map(async (token: TokenDataType) => {
        // Get the highest and lowest prices through multiple dexes
        const pools = await getTokenPriceUsingDexScreener(token);
        console.log('pools:', pools);

        // If there is one or no pool or max price equals with min price
        if (!pools || pools.numOfPools <= 1 || pools.min.priceUsd === pools.max.priceUsd) {
          console.log(`There is no or one pool with this token ${token.address}`);
        } else {
          ctx.reply(
            `min: $${pools.min.priceUsd}\ndex: ${pools.min.dexId}\n____________________\nmax: $${pools.max.priceUsd}\ndex: ${pools.max.dexId}`
          );
          // Swap logic
          // Purchase the tokens
          const buyResult = await swapTokens(
            SOL_ADDRESS,
            token.address,
            user.snipeAmount * SOL_DECIMAL,
            user.wallet.privateKey.toString(),
            user.jitoFee,
            user.slippageBps,
            pools.min.dexId
          );

          // If the purchase is successful
          if (buyResult.success === true) {
            ctx.reply(
              `Buy Success\nUsed ${buyResult.solDiff / SOL_DECIMAL} SOL\nGot ${
                (buyResult.outAmount || 0) / (token.decimals || 1e9)
              } ${token.symbol}`
            );

            // Looping until the sale is successful
            while (true) {
              const sellResult = await swapTokens(
                token.address,
                SOL_ADDRESS,
                buyResult.outAmount || 0,
                user.wallet.privateKey.toString(),
                user.jitoFee,
                user.slippageBps,
                pools.max.dexId
              );

              // If the sale is successful
              if (sellResult.success) {
                const pl = (Math.abs(sellResult.solDiff) - Math.abs(buyResult.solDiff)) / SOL_DECIMAL;
                ctx.reply(`Sell success!\nGot ${sellResult.solDiff / SOL_DECIMAL} SOL\n P/L: ${pl}`);
                break;
              }
            }
          } else {
            console.log('Purchase is failed');
          }
        }
      })
    );
  } catch (error) {
    console.error(error);
  }
});

bot.command('price', async (ctx) => {
  try {
    const price = await getTokenPriceOnRaydium();
    console.log(price);
    await ctx.reply(price?.toString() || 'Something went wrong.');
  } catch (error) {
    console.error(error);
  }
});

/**
 * The part to handle when 'start' command is inputted
 */
bot.command('start', startCommand);

/**
 * The part to handle when 'help' command is inputted
 */
bot.command('help', helpCommand);

/**
 * The part to handle when 'setting' command is inputted
 */
bot.command('setting', settingCommand);

//-------------------------------------------------------------------------------------------------------------+
//                                   The part to listen the messages from bot                                  |
//-------------------------------------------------------------------------------------------------------------+

bot.on('text', async (ctx) => {
  const botState = ctx.session.state;
  const text = ctx.message.text;
  const tgId = ctx.chat.id;
  try {
    const user = await User.findOne({ tgId });
    if (!user) {
      throw new Error('User not found');
    }
    if (
      botState === 'Snipe Amount' ||
      botState === 'Jito Fee' ||
      botState === 'Priority Fee' ||
      botState === 'Slippage'
    ) {
      if (botState === 'Snipe Amount') user.snipeAmount = Number(text);
      else if (botState === 'Priority Fee') user.priorityFee = Number(text);
      else if (botState === 'Slippage') user.slippageBps = Number(text);
      else user.jitoFee = Number(text);
      await user.save();
      await ctx.reply(settingText, await settingMarkUp(user));
      ctx.session.state = '';
    } else if (/(Start|Stop) Time/.test(botState as string)) {
      const { ok } = checkTimeFormat(text);
      if (ok === false) {
        await ctx.reply('Invalid time format. Please enter in this format <code>00:00</code>', { parse_mode: 'HTML' });
        return;
      }
      const [hour, minute] = text.split(':');
      const time = hour.trim().padStart(2, '0') + ':' + minute.trim().padStart(2, '0');
      if (botState.split(' ')[0] === 'Start') {
        const [stopHour, stopMin] = user.stopAt.split(':');
        if (
          Number(hour) > Number(stopHour) ||
          (Number(hour) == Number(stopHour) && Number(minute) >= Number(stopMin))
        ) {
          await ctx.reply('Invalid time! start time must be less than stop time');
          return;
        }
        user.startAt = time;
      } else {
        user.stopAt = time;
      }
      await user.save();
      await ctx.reply(settingText, await settingMarkUp(user));
    } else if (botState === 'Import Wallet') {
      const wallet = await generateWalletFromKey(text);
      user.wallet.publicKey = wallet?.publicKey || '';
      user.wallet.privateKey = wallet?.privateKey || '';
      user.wallet.amount = 0;
      await ctx.deleteMessage(ctx.message.message_id);
      await user.save();
      await ctx.reply(settingText, await settingMarkUp(user));
    } else {
      if (text.startsWith('/')) {
        ctx.reply('⚠️ Unrecognizable commands. Input /help to see the help.');
        return;
      }
    }
  } catch (error) {
    console.error('Error while on text:', error);
  }
});

//-------------------------------------------------------------------------------------------------------------+
//                                             Set the actions                                                 |
//-------------------------------------------------------------------------------------------------------------+

//---------------------------------------------------------------------+
//                         General Actions                             |
//---------------------------------------------------------------------+

/**
 * Catch the action when user clicks the 'Close' callback button
 */
bot.action('Close', (ctx, next) => checkAction(ctx, next, 'Close'), closeAction);

//---------------------------------------------------------------------+
//                      Actions on Start page                          |
//---------------------------------------------------------------------+

/**
 * Catch the action when user clicks the 'Start' callback button
 */
bot.action('Help', (ctx, next) => checkAction(ctx, next, 'Help'), helpAction);

/**
 * Catch the action when user clicks the 'Setting' callback button
 */
bot.action('Setting', (ctx, next) => checkAction(ctx, next, 'Setting'), settingAction);

//---------------------------------------------------------------------+
//                       Actions on Setting page                       |
//---------------------------------------------------------------------+

/**
 * Catch the action when user clicks the '💳 Wallet' callback button
 */
bot.action('Wallet', (ctx, next) => checkAction(ctx, next, 'Wallet'), walletAction);

/**
 * Catch the action when user clicks the '💳 Wallet' callback button
 */
bot.action('Import Wallet', (ctx, next) => checkAction(ctx, next, 'Import Wallet'), importWalletAction);

/**
 * Catch the action when user clicks the 'Bot On 🟢 || Bot Off 🔴' callback button
 */
bot.action('On Off', onOffAction);

/**
 * Catch the action when user clicks the '💵 Snipe Amount: * SOL' callback button
 */
bot.action(/Snipe Amount|Jito Fee|Priority Fee|Slippage/, inputAction);

/**
 * Catch the action when user clicks the 'Start' callback button
 */
bot.action('Return', (ctx, next) => checkAction(ctx, next, 'Return'), returnAction);

//---------------------------------------------------------------------+
//                        Actions on Wallet page                       |
//---------------------------------------------------------------------+

// bot.action('Create Wallet')

//-------------------------------------------------------------------------------------------------------------+
//                                    Set menu button to see all commands                                      |
//-------------------------------------------------------------------------------------------------------------+

/**
 * Set menu button representing all available commands
 */
// setCommands();

/**
 * Launch the bot
 */
bot
  .launch(() => {
    console.log('Bot is running...');
  })
  .catch(console.error);
