require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const logger = require('morgan');
const apiRouter = express.Router();

app.use(logger('dev', {}));
app.use(express.json());
app.use('/api', apiRouter);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

function formatKeywords(keywords) {
    const words = keywords.replace(/,/g, '').trim().split(/\s+/);
    return words.slice(0, 2).join(' ');
}

async function extractKeywords(prompt) {
    const searchPrompt = `
        사용자 질문: ${prompt}
        위 질문에 대한 SBS 뉴스 검색 키워드를 추출하세요:
        1. 질문의 핵심 주제와 관련된 키워드 1개 또는 2개 선정
        2. 가능한 고유명사 위주로 선별, 없으면 중요 일반명사 선택
        3. 사용자 질문에 없는 키워드 추출 금지
        4. 불필요한 조사나 일반적인 단어는 제외
        출력 형식: 키워드가 1개면 "키워드1", 2개면 "키워드1 키워드2"
    `.trim();

    try {
        const response = await axios.post('https://api.anthropic.com/v1/messages', {
            model: "claude-3-haiku-20240307",
            max_tokens: 64,
            temperature: 0,
            messages: [{ role: "user", content: searchPrompt }]
        }, {
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            }
        });

        const decodedText = iconv.decode(Buffer.from(response.data.content[0].text, 'utf8'), 'utf8');
        const formattedKeywords = formatKeywords(decodedText);
        console.log('Extracted keywords (decoded):', formattedKeywords);
        return formattedKeywords;
    } catch (error) {
        console.error('Error calling Claude API:', error);
        return "";
    }
}

async function fetchNewsData(query, limit = 20) {
    const url = `https://searchapi.news.sbs.co.kr/search/news?query=${encodeURIComponent(query)}&collection=news_sbs&offset=0&limit=${limit}`;

    try {
        const response = await axios.get(url);
        const articles = response.data.news_sbs || [];

        return articles.map(article => ({
            title: cleanText(article.TITLE),
            article: cleanText(article.REDUCE_CONTENTS),
            date: cleanText(article.DATE),
            link: `https://news.sbs.co.kr/news/endPage.do?news_id=${article.DOCID}`
        })).filter(article => article.title);
    } catch (error) {
        console.error('Error fetching news data:', error);
        return [];
    }
}

function cleanText(text) {
    return text.replace(/<!HS>|<!HE>/g, '')
        .replace(/<h4[^>]*>.*?<\/h4>/g, '')
        .replace(/\n+/g, '\n');
}

async function createEmbeddings(documents) {
    const embeddings = await Promise.all(documents.map(async (doc) => {
        const response = await openai.embeddings.create({
            model: "text-embedding-3-small",
            input: doc.article,
        });
        return {
            ...doc,
            embedding: response.data[0].embedding,
        };
    }));

    return embeddings;
}

async function storeEmbeddings(embeddings) {
    try {
        const { data, error } = await supabase
            .from('news_embeddings')
            .insert(embeddings);

        if (error) {
            console.error('Error storing embeddings:', error);
            throw error;
        }
        return data;
    } catch (error) {
        console.error('Error in storeEmbeddings:', error);
        throw error;
    }
}

async function findSimilarDocuments(query, k = 5) {
    const queryEmbedding = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: query,
    });

    const { data, error } = await supabase.rpc('match_documents', {
        query_embedding: queryEmbedding.data[0].embedding,
        match_threshold: 0.78,
        match_count: k
    });

    if (error) console.error('Error finding similar documents:', error);
    return data;
}

apiRouter.post('/searchNews', async function (req, res) {
    console.log('Received request:', JSON.stringify(req.body, null, 2));
    const userUtterance = req.body.userRequest.utterance;
    console.log('User utterance:', userUtterance);

    try {
        const keywords = await extractKeywords(userUtterance);
        console.log('Extracted keywords:', keywords);

        const newsData = await fetchNewsData(keywords);
        console.log('Fetched news data:', newsData.length, 'items');

        const embeddings = await createEmbeddings(newsData);
        console.log('Created embeddings:', embeddings.length, 'items');

        await storeEmbeddings(embeddings);
        console.log('Stored embeddings');

        const similarDocuments = await findSimilarDocuments(userUtterance);
        console.log('Similar documents:', similarDocuments);

        const responseBody = {
            version: "2.0",
            template: {
                outputs: [
                    {
                        simpleText: {
                            text: similarDocuments && similarDocuments.length > 0
                                ? "관련 뉴스 링크:\n" + similarDocuments.map(doc => doc.link).join('\n')
                                : "관련 뉴스를 찾을 수 없습니다."
                        }
                    }
                ]
            }
        };

        res.status(200).send(responseBody);
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).send({
            version: "2.0",
            template: {
                outputs: [{ simpleText: { text: "죄송합니다. 뉴스를 검색하는 중 오류가 발생했습니다." } }]
            }
        });
    }
});

app.listen(3000, function () {
    console.log('Example skill server listening on port 3000!');
});