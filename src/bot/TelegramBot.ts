import { ProductRepository } from './../database/repository';
import { Bot, Context, session } from 'grammy';
import { OrderProcessor } from '../services/orderProcessor';
import { defaultCronDays, MyContext, SessionData } from '../constants/common';
import mongoose from 'mongoose';
import { MongoDBAdapter } from '@grammyjs/storage-mongodb';
import { config } from '../config';
import { ChatRepository, OrderRepository } from '../database/repository';
import { adminRequiredMiddleware, BotContext, saveUserAndChatMiddleware } from './middleware';
import { commandHandlers } from '../commands/orderManagement';
import { DailySummaryCronJob } from '.';
import { catchReplyError } from '../utils/catchError';
import { registerCommands } from '../commands';

export class TelegramBot {
    private bot: Bot<MyContext>;
    private orderProcessor: OrderProcessor;

    constructor() {
        if (!config.telegram.token) {
            throw new Error('TELEGRAM_BOT_TOKEN is not set in environment variables');
        }
        this.bot = new Bot<BotContext>(config.telegram.token);

        //Services
        const orderRepo = new OrderRepository();
        this.orderProcessor = new OrderProcessor(orderRepo);
        this.setupMiddleware();
        this.setupHandlers();
    }

    public async handleSaveOrder(ctx: Context, userId: number, chatId: number, text: string): Promise<void> {
        try {
            const savedOrder = await this.orderProcessor.saveOrder(userId, chatId, text);
            if (savedOrder) {
                await ctx.react('👍');
                // if (savedOrder.productName && savedOrder?.amount > 0) {
                //     await ctx.react(  '👍');
                // } else {
                //     await ctx.reply('❌ Invalid product name or format. Please try different name or format e.g. "Cafe sữa đã - 52k" again.');
                // }
                // await ctx.reply(
                //     `✅ Order saved: ${savedOrder.productName} - ${savedOrder.amount / 1000}k`,
                //     { reply_to_message_id: ctx.msg.message_id }
                // );
            }
        } catch (error) {
            catchReplyError(error, ctx, 'message format');
        }
    }

    private setupMiddleware(): void {
        const collection = mongoose.connection.collection('sessions');
        this.bot.use(session({
            initial: (): SessionData => ({ isAdmin: false }),
            storage: new MongoDBAdapter({
                collection: collection as any,
            })
        }));

        // Add middleware to save user and chat information
        this.bot.use(saveUserAndChatMiddleware);
        // Init cronJob timer
        this.orderProcessor.initializeAllTimer(this.runDailySummary.bind(this));
        // Add command handlers
        this.bot.use(commandHandlers);
        this.bot.command('settime', adminRequiredMiddleware, async (ctx) => {
            const args = ctx.message?.text.split(' ').slice(1);
            if (!args || args.length !== 1) {
                await ctx.reply("Usage: /settime HH:MM (e.g., /settime 17:00)");
                return;
            }
            const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
            const timeInput = args[0];
            if (!timeRegex.test(args[0])) {
                await ctx.reply("⚠️ Invalid time format. Please use HH:MM (e.g., 17:00)");
                return;
            }
            const [hour, minute] = timeInput.split(":").map(String);
            const cronExpression = `${minute} ${hour} * * ${defaultCronDays}`;
            const chatRepo = new ChatRepository();
            try {
                const chat = await chatRepo.findByChatId(ctx.chatId);
                const jobDaily = new DailySummaryCronJob(cronExpression, this.runDailySummary.bind(this));
                if (chat) {
                    jobDaily.updateCronTime(cronExpression, this.runDailySummary.bind(this));
                    chatRepo.saveChat({
                        ...chat,
                        cronExpression: cronExpression
                    })
                    jobDaily.start();
                }
                await ctx.reply(`✅ Daily summary time set to ${hour}:${minute}`);
            } catch (error) {
                catchReplyError(error, ctx, 'settime');
            }
        });
    }

    private setupHandlers(): void {
        // Record chat information when the bot receives any message
        this.bot.on('msg', async (ctx) => {
            try {
                const userId = ctx.from?.id;
                const chatId = ctx.chatId;
                const text = ctx.message?.text || '';
                if (text?.startsWith('/')) {
                    return;
                }
                if (userId) {
                    await this.handleSaveOrder(ctx, userId, chatId, text);
                }
                // if (userId) {
                //     // Update user's last interaction
                //     await User.updateOne(
                //         { userId },
                //         {
                //             $set: { lastInteraction: new Date() }, 
                //             $inc: { messageCount: 1 }
                //         },
                //         { upsert: false }
                //     );
                //     if (text && text.startsWith("/chat")) {
                //         await handleChatImage(ctx);
                //         return;
                //     }
                //     await ctx.reply('I received your message! Try /profile to see your stats.');
                // }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        });

        this.bot.on('edited_message', async (ctx) => {
            const editedText = ctx.editedMessage.text;
            const userId = ctx.from?.id;
            const chatId = ctx.chatId;
            if (editedText) {
                await this.handleSaveOrder(ctx, userId, chatId, editedText);
            }
        })
    }

    private async runDailySummary(): Promise<void> {
        console.log(`Running daily summary job at ${new Date().toISOString()}`);
        try {
            await this.sendDailySummary();
            console.log('Daily summary completed successfully');
        } catch (error) {
            console.error('Error in daily summary job:', error);
        }
    }

    async sendDailySummary(): Promise<void> {
        try {
            const dailyTotals = await this.orderProcessor.calculateDailyTotals();

            // // Send to explicitly defined admins
            // for (const adminId of config.telegram.adminIds) {
            //     try {
            //         const botMessage = await this.bot.api.sendMessage(adminId, message, { parse_mode: 'Markdown' });
            //         await this.bot.api.pinChatMessage(botMessage.chat.id, botMessage.message_id);
            //     } catch (error) {
            //         console.error(`Error sending to admin ${adminId}:`, error);
            //     }
            // }

            // Get all active group chats and send summary
            const chatRepo = new ChatRepository();
            const groupChats = await chatRepo.getActiveGroupChats();
            
            for (const chat of groupChats) {
                const message = await this.orderProcessor.formatDailyTotalMessage(dailyTotals, chat.chatId);
                try {
                    const botMessage = await this.bot.api.sendMessage(chat.chatId, message, { parse_mode: 'Markdown' });
                    await this.bot.api.pinChatMessage(botMessage.chat.id, botMessage.message_id);
                } catch (error: any) {
                    console.error(`Error sending to group ${chat.chatId}:`, error);
                    // If we get a "bot was kicked" error, mark the chat as inactive
                    if (error.description &&
                        (error.description.includes('bot was kicked') ||
                            error.description.includes('chat not found'))) {
                        await chatRepo.saveChat({
                            ...chat,
                            isActive: false
                        });
                    }
                }
            }
        } catch (error) {
            console.error('Error sending daily summary:', error);
        }
    }

    async start(): Promise<void> {
        // await this.bot.api.setMyCommands(getAllCommands());
        // registerCommands(this.bot);
        // await initializeAllReminders(this.bot.api);

        // this.bot.hears("ping", async (ctx) => {
        //     await ctx.reply("pong", {
        //         reply_parameters: { message_id: ctx.msg.message_id },
        //     });
        // });

        // this.bot.catch((err) => {
        //     console.error('Error in bot:', err);
        // });
        try {
            await this.bot.start({
                onStart: () => console.log('Telegram bot started successfully')
            });
        } catch (error) {
            console.error('Error starting Telegram bot:', error);
            throw error;
        }
    }

    async stop(): Promise<void> {
        await this.bot.stop();
        console.log('Telegram bot stopped');
    }
}
