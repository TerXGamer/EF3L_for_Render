# افعل for Render

نسخة Render من تطبيق افعل. الواجهة هي نفس نسخة افعل، مع خادم Node صغير بدل Netlify Functions، وتخزين الحسابات والمزامنة في Render PostgreSQL.

## التشغيل على Render

اربط مستودع GitHub هذا مع Render باستخدام Blueprint من ملف `render.yaml`.

- Build command: `npm ci && npm run build`
- Start command: `npm start`
- Health check: `/health`
- Account API: `/api/account`

ملف `render.yaml` ينشئ خدمة Web Service وقاعدة PostgreSQL ويربط `DATABASE_URL` تلقائيًا.

ملاحظة مهمة: قاعدة PostgreSQL المجانية في Render مناسبة للتجربة، لكنها تنتهي بعد 30 يومًا حسب سياسة Render الحالية. للموقع الحقيقي أو البيانات المهمة، استخدم خطة مدفوعة أو قاعدة بيانات خارجية دائمة.

## التشغيل المحلي

ضع رابط قاعدة PostgreSQL في `DATABASE_URL` ثم شغل:

```bash
npm install
npm run build
npm start
```

ثم افتح:

```text
http://localhost:3000
```

## الملفات المهمة

- `server.mjs`: خادم Render وواجهة الحسابات.
- `render.yaml`: إعداد Render Blueprint.
- `index.html`, `styles.css`, `app.js`: واجهة تطبيق افعل.
- `build.mjs`: فحص خفيف قبل تشغيل Render.
