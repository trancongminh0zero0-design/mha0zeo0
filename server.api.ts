/**
 * Backend-only API server (4-zone architecture).
 * No static files — served exclusively from /home/mha/frontend/dist via gateway.
 */
import express from 'express';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { generateGeminiChatReply, type GeminiChatContent } from './server.gemini';

const sandboxEnv = process.env.SANDBOX_ENV || '/home/mha/sandbox/.env';
dotenv.config({ path: sandboxEnv });

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY_TURNS = 6;

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  if (process.env.BEHIND_CLOUDFLARE !== 'true') return next();
  if (req.path === '/api/health') return next();
  if (!req.headers['cf-ray']) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', zone: 'backend', time: new Date().toISOString() });
});

app.post('/api/chat', chatRateLimiter, async (req, res) => {
  const { message, history, productsContext } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message is required' });
  }

  const trimmedMessage = message.trim();
  if (!trimmedMessage || trimmedMessage.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ error: 'Invalid message length' });
  }

  const formattedProducts = Array.isArray(productsContext)
    ? productsContext
        .slice(0, 50)
        .map(
          (p: {
            id: string;
            name: string;
            price: number;
            shop: string;
            stars: number;
            category: string;
            desc?: string;
          }) =>
            `- ID: ${p.id}, Tên: ${p.name}, Giá: ${p.price.toLocaleString('vi-VN')}đ, Sàn: ${p.shop}, Đánh giá: ${p.stars}/5, Danh mục: ${p.category}, Mô tả: ${p.desc || 'Chất lượng tốt'}`
        )
        .join('\n')
    : '';

  const systemInstruction = `Bạn là Trợ lý AI tư vấn mua sắm trực tuyến vô cùng thân thiện, súc tích và chuyên nghiệp tại "TiviTapHoa" — sàn thương mại điện tử mua sắm liên kết (Affiliate Store) chuẩn SEO và tối ưu nhất tại Việt Nam.

Nhiệm vụ cốt lõi của bạn:
1. Tư vấn, gợi ý, so sánh giá cả các sản phẩm có sẵn trong danh sách của cửa hàng dưới đây.
2. Trả lời bằng tiếng Việt lịch sự, trẻ trung, dùng emoji phù hợp.
3. Khi khách hỏi mua, hãy gợi ý họ bấm nút "+ Thêm" để đưa vào giỏ hàng cục bộ, hoặc bấm "Mua tại sàn" để di chuyển trực tiếp tới link đại lý liên kết.
4. Trả lời súc tích dưới 120 từ, tránh lan man rườm rà.

Danh sách sản phẩm hiện tại của cửa hàng:
${formattedProducts}

Vui lòng trả lời câu hỏi sau của khách hàng dựa trên thông tin trên.`;

  const fallbackReply =
    'Hệ thống AI hiện đang bận một chút, bạn có thể hỏi về các sản phẩm như tai nghe Sony, Note 13, đầm maxi... để mình hỗ trợ nhé! 📦';

  try {
    const chatContents: GeminiChatContent[] = [
      { role: 'user', parts: [{ text: systemInstruction }] },
    ];

    if (Array.isArray(history)) {
      history.slice(-MAX_HISTORY_TURNS).forEach((h: { role?: string; content?: string }) => {
        if (typeof h.content !== 'string' || !h.content.trim()) return;
        chatContents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content.slice(0, MAX_MESSAGE_LENGTH) }],
        });
      });
    }

    chatContents.push({ role: 'user', parts: [{ text: trimmedMessage }] });

    const reply = await generateGeminiChatReply(chatContents);
    if (!reply) {
      return res.json({
        reply:
          'Chào bạn! Mình là trợ lý TiviTapHoa. Hiện tại hệ thống đang được cấu hình. Bạn có muốn mình hỗ trợ hướng dẫn xem các sản phẩm Hot ở thanh điều hướng phía trên không? 😊',
      });
    }

    res.json({ reply });
  } catch (error) {
    console.error('Gemini API Error:', error);
    res.json({ reply: fallbackReply });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`[backend] API listening at http://${HOST}:${PORT} (sandbox: ${sandboxEnv})`);
});
