# Handle

دي نسخة موقع المحادثة بنفس التصميم، جاهزة للنشر على GitHub Pages. حسابات المستخدمين والمحادثات والرسائل محفوظة في قاعدة Supabase سحابية وتظهر على الأجهزة المختلفة.

## النشر على GitHub

1. فك ضغط الملف.
2. ارفع محتويات مجلد الموقع إلى جذر مستودع جديد على GitHub، على الفرع main. ارفع الملفات والمجلدات نفسها، وليس ملف ZIP.
3. اجعل المستودع Public إذا كنت تستخدم GitHub Free.
4. افتح Settings ثم Pages، واختر GitHub Actions في خانة Source.
5. افتح Actions وانتظر انتهاء Deploy Handle to GitHub Pages. رابط الموقع سيظهر في Settings ثم Pages.

ملف البداية البرمجي هو app/page.tsx. أثناء النشر، GitHub Actions يبني الموقع ويُنشئ الصفحة الرئيسية في out/index.html وينشر مجلد out. إعداد البناء يضبط رابط المستودع تلقائيًا.

## التشغيل على جهازك

ثبّت Node.js 22 وpnpm 12، ثم افتح مجلد الموقع في VS Code وشغّل pnpm install وبعده pnpm dev. افتح http://localhost:3000. التشغيل المحلي يستخدم قاعدة البيانات السحابية نفسها.

## قاعدة البيانات

مشروع Supabase باسم handle-chat-cloud جاهز، ومخطط البيانات ووظيفة handle-chat تم إعدادهم. رابط المشروع:
https://supabase.com/dashboard/project/uzzjkfriikqsoxjlzjbe

المفتاح الموجود في ملفات المتصفح مفتاح نشر عام. المفتاح الخاص موجود داخل Supabase فقط ولا ترفعه على GitHub.

GitHub Pages يستضيف الموقع. Supabase يحفظ الحسابات والرسائل؛ GitHub وحده لا يشغّل قاعدة بيانات أو خادم محادثة.