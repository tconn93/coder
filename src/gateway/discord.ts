import { Client, Events, GatewayIntentBits, Message } from 'discord.js';
import { AgentOrchestrator } from '../agent/index.js';
import type { AgentOptions } from '../types.js';
import chalk from 'chalk';

export class DiscordGateway {
  private client: Client;
  private orchestrator: AgentOrchestrator;
  private token: string;
  private baseOptions: AgentOptions;

  constructor(token: string, orchestrator: AgentOrchestrator, baseOptions: AgentOptions) {
    this.token = token;
    this.orchestrator = orchestrator;
    this.baseOptions = baseOptions;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.once(Events.ClientReady, c => {
      console.log(chalk.green(`\n✓ Discord Gateway active. Logged in as ${c.user.tag}`));
    });

    this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
  }

  public async start() {
    try {
      await this.client.login(this.token);
    } catch (e) {
      console.error(chalk.red(`Failed to connect to Discord:`), (e as Error).message); // added space
    }
  }

  private async handleMessage(message: Message) {
    if (message.author.bot) return;

    // Trigger on bot mention or '!coder'
    const botId = `<@${this.client.user?.id}>`;
    let prompt = message.content;

    const isMention = prompt.startsWith(botId);
    const isCommand = prompt.startsWith('!coder ');
    
    if (!isMention && !isCommand) {
        // Also respond to DMs natively without prefix
        if (message.guildId) return;
    }

    if (isMention) prompt = prompt.substring(botId.length).trim();
    if (isCommand) prompt = prompt.substring('!coder '.length).trim();

    if (!prompt) return;

    console.log(chalk.cyan(`[Discord Gateway] Request from ${message.author.tag}: ${prompt.substring(0, 50)}...`));

    // Send initial response
    let currentDiscordMsg = await message.reply('⏳ *Thinking...*');
    let buffer = '';
    
    // Interval to flush buffer to avoid discord rate limits (edit rate limit is ~1s)
    let lastEditTime = Date.now();
    const updateRateLimit = 2000;

    const flushBuffer = async () => {
      if (!buffer.trim() || !currentDiscordMsg) return;
      try {
        // If buffer gets too large, chunk it
        if (buffer.length > 1900) {
           currentDiscordMsg = await message.reply(buffer.substring(0, 1900));
           buffer = buffer.substring(1900);
        } else {
           await currentDiscordMsg.edit(buffer);
        }
      } catch (e) {
          console.error("Discord edit err:", e);
      }
    };

    const flushInterval = setInterval(async () => {
      if (Date.now() - lastEditTime > updateRateLimit && buffer) {
        await flushBuffer();
        lastEditTime = Date.now();
      }
    }, updateRateLimit);

    try {
        // We defer exactly to the orchestrator defaults for config
        const opts = { ...this.baseOptions };
        
        for await (const event of this.orchestrator.run(prompt, opts)) {
            if (event.type === 'text') {
                buffer += (event.data as string).replace(/<[^>]*>/g, ''); // Discord markdown filter
            } else if (event.type === 'tool_call') {
                const tc = event.data as { name: string };
                buffer += `\n🔨 *Running tool: ${tc.name}...*\n`;
            } else if (event.type === 'subagent') {
                const req = event.data as { name: string, status: string };
                buffer += `\n🤖 *Subagent [${req.name}]: ${req.status}*\n`;
            } else if (event.type === 'error') {
                buffer += `\n❌ **Error:** ${(event.data as any).message}\n`;
            }
        }
    } catch (e) {
        await message.reply(`❌ Core Execution Error: ${(e as Error).message}`);
    } finally {
        clearInterval(flushInterval);
        await flushBuffer(); // final flush
    }
  }
}
