import express from 'express';
import { Database } from './database/db';
import { TelegramBot } from './bot/TelegramBot';
import { logger } from './utils/logger';
import { config } from './config';
// import { productsRouter, test } from './api/v1/controllers/ProductController';
import routes from './routes/index.route'
// import { webhookCallback } from 'grammy';
const app = express();
const port = config.port;

const initApi = (bot: any) => {
    try {
        // app.use(productsRouter);
        // app.use("/api/v1/test", test);
        // app.use("/webhook", webhookCallback(bot, "express"));
        // app.get("/", (_, res) => res.send("Bot is running."));
        app.use(express.json());
        app.use(routes);
        app.listen(port, () => {
            console.log(`Server is running on port ${port}`);
            logger.info(`Server is running on port ${port}`);
        });
    } catch (error) {
        logger.error('Error api' + error);
    }
}

async function main() {
    try {
        console.log("Service started...");
        // Connect to MongoDB
        const db = new Database();
        await db.connect();
        const teleBot = new TelegramBot();
        initApi(teleBot);
        // Start the bot
        await teleBot.start();
        process.on('SIGINT', async () => {
            console.log('Shutting down...');
            await db.close();
            await teleBot.stop();
            process.exit(0);
        });
    } catch (error) {
        // Handle errors
        const errorMessage = 'Failed to start application:';
        console.error(errorMessage + error);
        logger.error(errorMessage, error);
        process.exit(1);
    }
}
// Execute
main();