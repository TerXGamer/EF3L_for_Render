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

## صلاحيات الادمن

في Render > Environment Variables:

- **Key:** `ADMIN_SET`
- **Value:** أسماء مستخدمي الادمن مفصولة بفاصلة، مثل:
  `admin1, admin2, admin3`

عند تسجيل الدخول بأحد هذه الأسماء، تظهر قائمة **الادمن** داخل الإعدادات.

- في البداية تُعرض **أسماء المستخدمين فقط**.
- عند الضغط على **كشف** يجلب السيرفر بيانات ذلك المستخدم ومهامه.
- سجل المهام يقتصر على **الشهر الحالي فقط**.

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

- `server.mjs`: خادم Render وواجهة الحسابات وواجهة الادمن.
- `render.yaml`: إعداد Render Blueprint.
- `index.html`, `styles.css`, `app.js`: واجهة تطبيق افعل.
- `app.js.br.b64`: نسخة مضغوطة من `app.js` تُنشأ تلقائيًا عند البناء.
- `build.mjs`: فحص الملفات وإنشاء `app.js.br.b64` قبل التشغيل.
