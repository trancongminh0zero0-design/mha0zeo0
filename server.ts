import express from 'express';
import dotenv from 'dotenv';
import { registerAdminRoutes } from './server.admin';
import { registerStoreRoutes } from './server.store';
import { registerCustomerRoutes } from './server.customer';
import { generateGeminiChatReply, type GeminiChatContent } from './server.gemini';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '12mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

registerAdminRoutes(app);
registerStoreRoutes(app);
registerCustomerRoutes(app);

app.post('/api/chat', async (req, res) => {
  const { message, history, productsContext } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const formattedProducts = Array.isArray(productsContext)
    ? productsContext.map(
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
      ).join('\n')
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

  try {
    const chatContents: GeminiChatContent[] = [{ role: 'user', parts: [{ text: systemInstruction }] }];

    if (Array.isArray(history)) {
      history.slice(-6).forEach((h: { role?: string; content?: string }) => {
        chatContents.push({
          role: h.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: h.content || '' }],
        });
      });
    }

    chatContents.push({ role: 'user', parts: [{ text: message }] });

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
    res.json({
      reply:
        'Hệ thống AI hiện đang bận một chút, bạn có thể hỏi về các sản phẩm như tai nghe Sony, Note 13, đầm maxi... để mình hỗ trợ nhé! 📦',
    });
  }
});

async function startServer() {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dev server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start dev server:', err);
});
