import { openai as openaiClient } from '@ai-sdk/openai';
import { experimental_generateImage as generateImage, generateObject, generateText } from 'ai';
import { configDotenv } from 'dotenv';
import { z } from 'zod';
import { AGENT_XUN_PROMPT, TREND_ANALYSIS_PROMPT } from '../config/prompts';
import { TEST_MENTIONS } from '../config/testData';
import { Agent } from '../modules/agent';
import { prisma } from '../modules/db';
import { OpenAIModule } from '../modules/openai';
import { PumpfunService } from '../modules/pumpfun';
import { TwitterModule } from '../modules/twitter';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
configDotenv();

async function generateTokenData(insight: string) {
    try {
        // Generate token details using generateObject
        const { object: tokenDetails } = await generateObject({
            model: openaiClient("gpt-4o-mini"),
            prompt: `Based on this insight: "${insight}"
            Generate a creative crypto token concept.
            Important: Keep the description under 100 characters, be very concise.`,
            schema: z.object({
                name: z.string().max(20).describe("A catchy name"),
                ticker: z.string().min(3).max(4).describe("A ticker symbol"),
                description: z.string().max(100).describe("A very brief description (max 100 chars)")
            })
        });

        // Generate image using DALL-E
        const imagePrompt = `Create a modern, professional crypto token logo for ${tokenDetails.name}. 
        The logo should be minimal, memorable, and suitable for a cryptocurrency token.`;

        const { image } = await generateImage({
            model: openaiClient.image("dall-e-3"),
            prompt: imagePrompt
        });

        //save image to file
        const imageBuffer = Buffer.from(image.base64, 'base64');
        if (!existsSync('./images')) {
            mkdirSync('./images');
        }
        writeFileSync(`./images/${tokenDetails.name}.png`, imageBuffer);

        return {
            ...tokenDetails,
            image
        };
    } catch (error) {
        console.error('Error generating token data:', error);
        throw error;
    }
}

export async function runTrendAnalysis() {
    try {
        const agent = new Agent();
        const openai = OpenAIModule.getInstance();

        // Fetch both news and tweets
        const [news, tweets] = await Promise.all([
            agent.fetchTrends(),
            agent.fetchTwitterPosts()
        ]);
        // Prepare the data for analysis
        const newsHeadlines = news.map(post => post.title).join('\n');
        const tweetTexts = tweets.map(tweet => tweet.text).join('\n');
        // Combine the data for the prompt
        const analysisInput = `
Headlines:
${newsHeadlines}

Tweets:
${tweetTexts}
`;

        // Generate analysis using OpenAI
        const response = await openai.query(TREND_ANALYSIS_PROMPT + '\n\n' + analysisInput);
        const analysis = response.choices[0].message.content;
        if (!analysis) {
            throw new Error("No analysis found");
        }
        // Log the analysis
        console.log('Generated Analysis:', analysis);

        // Tweet the analysis
        const twitter = await TwitterModule.getInstance();
        await twitter.postTweet({ text: analysis });

        return {
            analysis,
        };
    } catch (error) {
        throw error;
    }
}

export async function parseMentions(isTest = process.env.NODE_ENV === 'development') {
    try {
        const twitter = await TwitterModule.getInstance();
        const mentions = isTest
            ? TEST_MENTIONS
            : await twitter.getMentions();

        // Prepare all tweets for a single analysis
        const tweetsForAnalysis = mentions.data.map(mention => ({
            id: mention.id,
            text: mention.text
        }));

        const { object: analysisResults } = await generateObject({
            model: openaiClient("gpt-4o-mini"),
            prompt: `Analyze these tweets:
            ${JSON.stringify(tweetsForAnalysis, null, 2)}
            
            For each tweet, determine:
            1. If it requires a reply
            2. If it's pitching a token idea
            3. If we need more information about the token
            4. If it's a good token idea to deploy
            Provide detailed reasoning for each.`,
            schema: z.object({
                results: z.array(z.object({
                    tweetId: z.string().describe("ID of the tweet"),
                    deserves_reply: z.boolean().describe("Whether this tweet needs a response"),
                    pitching_token: z.boolean().describe("Whether this is a token pitch"),
                    need_info: z.boolean().describe("Whether we need more information about the token"),
                    good_idea_to_deploy: z.boolean().describe("Whether this token idea seems viable"),
                    reasoning: z.string().describe("Explanation for the analysis")
                }))
            })
        });

        // Process each analyzed mention
        const pumpfunService = new PumpfunService();

        for (const result of analysisResults.results) {
            try {
                if (result.deserves_reply || result.pitching_token) {
                    if (result.pitching_token && result.good_idea_to_deploy) {
                        // Generate token data for viable pitches
                        const { name, ticker, description, image } = await generateTokenData(result.reasoning);

                        const conversation = await prisma.conversation.create({
                            data: {
                                conversationId: result.tweetId,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                            }
                        });

                        const tweet = mentions.data.find(tweet => tweet.id === result.tweetId);
                        if (!tweet) {
                            continue
                        }
                        await prisma.tweet.create({
                            data: {
                                tweetId: tweet?.id,
                                text: tweet?.text,
                                createdAt: new Date(),
                                updatedAt: new Date(),
                                conversationId: conversation.id,
                                authorId: tweet?.author_id || '',
                            }
                        });
                        // Create token record in database
                        const token = await prisma.token.create({
                            data: {
                                name: name,
                                ticker: ticker,
                                description: description,
                                reasoning: result.reasoning,
                                twitter: `https://x.com/${result.tweetId}`,
                                website: "https://agentxun.ai",
                                createdAt: new Date(),
                                updatedAt: new Date(),
                                conversationId: conversation.id,
                            }
                        });

                        // Deploy token on-chain
                        const tokenAddress = await pumpfunService.createToken(token, image);

                        const reply = await generateText({
                            model: openaiClient("gpt-4o-mini"),
                            prompt: `Generate a reply to the following tweet: ${result.tweetId} you are AgentXun ${AGENT_XUN_PROMPT}
                            
                            A token has been created with the following details:
                            Name: ${token.name}
                            Ticker: ${token.ticker}
                            Description: ${token.description}
                            Address: ${tokenAddress}
                            `,
                        });

                        console.log(reply.text);
                        // const tweetreply = await twitter.reply(reply.text, result.tweetId);
                        // await prisma.tweet.create({
                        //     data: {
                        //         tweetId: tweetreply.data.id,
                        //         text: tweetreply.data.text,
                        //         createdAt: new Date(),
                        //         updatedAt: new Date(),
                        //         conversationId: conversation.id,
                        //         authorId: "1883089605811208192",
                        //     }
                        // });
                    } else {
                        const reply = await generateText({
                            model: openaiClient("gpt-4o-mini"),
                            prompt: `Generate a reply to the following tweet: ${result} you are AgentXun ${AGENT_XUN_PROMPT}`,
                        });

                        console.log(reply.text);
                        // await twitter.reply(reply.text, result.tweetId);
                    }
                }
            } catch (error) {
                console.error(`Error processing mention ${result.tweetId}:`, error);
                // Continue with other mentions even if one fails
                continue;
            }
        }

        return analysisResults;
    } catch (error) {
        console.error('Error parsing mentions:', error);
        throw error;
    }
}

