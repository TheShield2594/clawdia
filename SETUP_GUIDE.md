# UltraBot Setup Guide

## Table of Contents
1. [Discord Bot Setup](#discord-bot-setup)
2. [AI Integration](#ai-integration)
3. [Daily News Configuration](#daily-news-configuration)
4. [Dashboard Setup](#dashboard-setup)
5. [Portainer Deployment](#portainer-deployment)

## Discord Bot Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name your bot and click "Create"
4. Go to the "Bot" section
5. Click "Add Bot"
6. Copy the bot token (this is your `DISCORD_TOKEN`)
7. Enable these Privileged Gateway Intents:
   - Server Members Intent
   - Message Content Intent
   - Presence Intent

### 2. Get Client ID and Secret

1. In the same application, go to "OAuth2" > "General"
2. Copy your "Client ID" (this is your `CLIENT_ID`)
3. Copy your "Client Secret" (this is your `CLIENT_SECRET`)
4. Add redirect URL: `http://localhost:3000/auth/callback` (or your domain)

### 3. Invite Bot to Server

Use this URL (replace CLIENT_ID with yours):
```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

## AI Integration

### OpenAI (GPT-3.5/GPT-4)

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Go to [API Keys](https://platform.openai.com/api-keys)
4. Click "Create new secret key"
5. Copy the key (starts with `sk-...`)
6. Add to `.env` as `OPENAI_API_KEY=sk-...`

**Alternative:** Add the API key per-server in the bot dashboard under AI Chat settings.

**Pricing:** 
- GPT-3.5 Turbo: ~$0.002 per 1K tokens
- GPT-4: ~$0.03 per 1K tokens
- Check latest pricing at [OpenAI Pricing](https://openai.com/pricing)

### Google Gemini

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Select or create a Google Cloud project
4. Copy the API key (starts with `AIza...`)
5. Add to `.env` as `GEMINI_API_KEY=AIza...`

**Alternative:** Add the API key per-server in the bot dashboard under AI Chat settings.

**Pricing:**
- Gemini Pro: Free tier available (60 requests per minute)
- Check latest pricing at [Google AI Pricing](https://ai.google.dev/pricing)

### Choosing Between OpenAI and Gemini

**OpenAI (GPT-3.5/4):**
- Pros: More mature, better for complex tasks, extensive fine-tuning
- Cons: Costs money after free trial, requires payment method

**Google Gemini:**
- Pros: Free tier available, fast responses, good for general tasks
- Cons: Newer platform, fewer customization options

**Recommendation:** Start with Gemini for testing (free), then add OpenAI if you need more advanced capabilities.

## Daily News Configuration

### Finding RSS Feeds

Most news sites and blogs provide RSS feeds. Here are some examples:

**Major News Sources:**
- BBC: `http://feeds.bbci.co.uk/news/rss.xml`
- CNN: `http://rss.cnn.com/rss/cnn_topstories.rss`
- Reuters: `https://www.reutersagency.com/feed/`
- TechCrunch: `https://techcrunch.com/feed/`
- The Verge: `https://www.theverge.com/rss/index.xml`

**Finding RSS Feeds:**
1. Look for RSS icon on websites
2. Check `/feed`, `/rss`, or `/feed.xml` paths
3. Use browser extensions like "RSS Feed Reader"
4. Use RSS feed discovery tools

### Configuration Steps

1. Open the bot dashboard
2. Select your server
3. Go to "Daily News" tab
4. Enable Daily News Digest
5. Select a channel for posting
6. Set delivery time (e.g., `09:00` for 9 AM)
7. Add RSS feed URLs (one per line)
8. Set max items per feed (1-10)
9. Customize the digest title
10. Save settings

### Testing Daily News

Use the `/dailynews` command (requires administrator permissions) to manually trigger a digest and test your configuration.

## Dashboard Setup

### Environment Variables

Create a `.env` file with these required variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here

# Database
MONGODB_URI=mongodb://mongodb:27017/ultrabot

# Dashboard
DASHBOARD_PORT=3000
DASHBOARD_URL=http://localhost:3000
SESSION_SECRET=random_string_here_32_characters_min

# AI (Optional - can also configure per-server in dashboard)
OPENAI_API_KEY=sk-your_openai_key_here
GEMINI_API_KEY=AIza_your_gemini_key_here

# Music (Optional)
YOUTUBE_COOKIE=your_youtube_cookie_if_needed

# Environment
NODE_ENV=production
```

### Generating Session Secret

Use this command to generate a secure session secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Portainer Deployment

### Method 1: Docker Compose in Portainer

1. Open Portainer
2. Go to "Stacks"
3. Click "Add stack"
4. Name it "ultrabot"
5. Paste the `docker-compose.yml` content
6. Add environment variables in the env section or upload `.env` file
7. Click "Deploy the stack"

### Method 2: Manual Container Creation

1. Create a custom bridge network: `ultrabot-network`
2. Deploy MongoDB container first
3. Deploy bot container with environment variables
4. Link containers to the network

### Updating the Bot

**With Portainer:**
1. Go to Stacks > ultrabot
2. Click "Pull and redeploy"

**Manual:**
```bash
docker-compose pull
docker-compose up -d
```

### Viewing Logs

**Portainer:** Stacks > ultrabot > bot > Logs

**Command line:**
```bash
docker logs ultrabot -f
```

## Database Management

### MongoDB Connection

The bot automatically creates the database and collections. No manual setup needed.

### Backup Database

```bash
docker exec ultrabot-mongodb mongodump --out /data/backup
docker cp ultrabot-mongodb:/data/backup ./backup
```

### Restore Database

```bash
docker cp ./backup ultrabot-mongodb:/data/backup
docker exec ultrabot-mongodb mongorestore /data/backup
```

## Troubleshooting

### Bot Not Responding

1. Check bot is online in Discord
2. Verify `DISCORD_TOKEN` is correct
3. Check intents are enabled in Discord Developer Portal
4. View logs: `docker logs ultrabot`

### Dashboard Not Loading

1. Check port 3000 is accessible
2. Verify `DASHBOARD_URL` matches your domain
3. Check MongoDB is running: `docker ps`

### AI Not Working

1. Verify API key is correct
2. Check you have credits/quota remaining
3. Try switching providers (OpenAI ↔ Gemini)
4. Check logs for specific error messages

### Daily News Not Posting

1. Verify RSS feed URLs are valid
2. Check delivery time is in correct format (HH:MM)
3. Ensure channel ID is valid
4. Test with `/dailynews` command
5. Check bot has permission to post in channel

### Music Not Playing

1. Verify bot has voice permissions
2. Check YouTube cookies if videos are restricted
3. Verify ffmpeg is installed (included in Docker)
4. Try different video sources

## Best Practices

### Security

- Never share your `.env` file or API keys
- Use strong session secrets (32+ characters)
- Limit bot permissions to only what's needed
- Regularly update dependencies

### Performance

- Use MongoDB indexes for large servers
- Limit RSS feed checks to reasonable intervals (5-10 minutes)
- Monitor API usage to avoid rate limits
- Use caching where possible

### Moderation

- Set up moderation log channel
- Configure auto-mod before enabling
- Test moderation commands in a test channel first
- Create staff roles with appropriate permissions

### AI Usage

- Set reasonable system prompts
- Monitor AI responses for quality
- Use per-server API keys for cost control
- Enable AI only in designated channels

## Getting Help

- Check logs first: `docker logs ultrabot -f`
- Review this guide thoroughly
- Check Discord.js documentation for bot issues
- Review API provider documentation for AI issues

## Next Steps

After basic setup:

1. Configure welcome messages with custom cards
2. Set up leveling and economy systems
3. Add RSS feeds for your community's interests
4. Configure auto-moderation rules
5. Set up music for 24/7 streaming
6. Create custom commands in dashboard
7. Set up auto-roles for new members

Enjoy your fully-featured Discord bot! 🚀