# تشغيل عين الصقر على حاسوب Windows جديد

هذه الخطوات خاصة بفرع `broadcast-station-mvp` وتُنشئ محطة محلية مستقرة مع رابط ثابت للمشاهد.

## 1. تثبيت الأدوات الأساسية

افتح **PowerShell** كمسؤول ونفّذ:

```powershell
winget install --id Git.Git --exact --source winget --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
```

أغلق PowerShell وافتحه مجدداً، ثم تحقق:

```powershell
git --version
node --version
npm --version
```

يلزم Node.js 22 أو أحدث. يوصى بإصدار LTS.

## 2. تنزيل المشروع

```powershell
cd $HOME\Documents
git clone --branch broadcast-station-mvp --single-branch https://github.com/Omar-Khaleel/worldmonitor.git Ain-Al-Saqr
cd Ain-Al-Saqr
```

عندما يكون المستودع موجوداً مسبقاً:

```powershell
cd $HOME\Documents\Ain-Al-Saqr
git fetch origin
git checkout broadcast-station-mvp
git pull --ff-only origin broadcast-station-mvp
```

## 3. الإعداد التلقائي

انقر مرتين على:

```text
INSTALL-AIN-SAQR.cmd
```

أو نفّذ من PowerShell:

```powershell
.\INSTALL-AIN-SAQR.cmd
```

يقوم المثبّت بما يأتي:

- التحقق من Git وNode.js.
- تحديث الفرع بطريقة لا تدمج تغييرات غير متوقعة.
- تثبيت الحزم المطابقة لـ`package-lock.json` بواسطة `npm ci`.
- إنشاء `.env.local` من دون أسرار.
- إنشاء اختصار للتشغيل وآخر للإيقاف على سطح المكتب.
- تشغيل المحطة وفحص المسارات والمزامنة والشريط.

## 4. الترجمة المحلية بواسطة Ollama

لتثبيت Ollama والنموذج تلقائياً:

```powershell
.\INSTALL-AIN-SAQR.cmd -InstallOllama
```

أو ثبّت Ollama يدوياً ثم نفّذ:

```powershell
setx OLLAMA_ORIGINS "http://localhost:3000,http://127.0.0.1:3000"
ollama pull qwen2.5:7b
```

بعد ذلك اختر من غرفة التحكم:

```text
مصدر الترجمة: Ollama محلي
العنوان: http://127.0.0.1:11434
النموذج: qwen2.5:7b
```

## 5. التشغيل اليومي

استخدم اختصار **تشغيل عين الصقر** على سطح المكتب، أو:

```powershell
.\START-AIN-SAQR.cmd
```

يقوم المشغّل تلقائياً بما يأتي:

- إعادة استخدام المحطة إن كانت تعمل.
- إيجاد منفذ متاح بين 3000 و3020 عند انشغال المنفذ الافتراضي.
- إنشاء معرّف محطة ثابت وحفظه في `.runtime/station-id.txt`.
- تشغيل Vite في الخلفية.
- فحص غرفة التحكم وصفحة المشاهد وواجهة الحالة والشريط وRSS.
- فتح غرفة التحكم في المتصفح.
- طباعة رابط المشاهد المحلي ورابط الشبكة الداخلية.

لفتح المشاهد أيضاً أثناء التشغيل:

```powershell
.\START-AIN-SAQR.cmd -OpenViewer
```

للإيقاف:

```powershell
.\STOP-AIN-SAQR.cmd
```

## 6. الروابط

يظهر المشغّل الرابطين الدقيقين. يكونان عادةً بالشكل الآتي:

```text
http://127.0.0.1:3000/control/?station=ayn-xxxxxxxxxxxxxxxx&lang=ar
http://127.0.0.1:3000/broadcast/?station=ayn-xxxxxxxxxxxxxxxx&lang=ar
```

لا تستخدم `/broadcast/` من دون `station` في OBS أو جهاز المشاهد. معرّف المحطة ثابت على هذا الحاسوب ولا يتغير مع إعادة التشغيل.

## 7. فحص الأعطال

شغّل الطبيب والمحطة تعمل:

```powershell
node .\scripts\broadcast-doctor.mjs --base http://127.0.0.1:3000
```

يفحص:

- استقلال `/control/` عن `/broadcast`.
- عدم تحميل الإدارة داخل المشاهد.
- نشر الحالة وقراءتها.
- الفحص الشرطي للتحديثات.
- وجود الخبر داخل حالة الشريط.
- RSS الاحتياطي.
- مزود الترجمة وOllama كفحوص اختيارية.

السجلات موجودة في:

```text
.runtime/server.out.log
.runtime/server.error.log
```

## 8. الوصول من جهاز آخر داخل الشبكة

شغّل المحطة، ثم استخدم رابط الشبكة الذي يطبعه المشغّل، مثلاً:

```text
http://192.168.1.20:3000/broadcast/?station=ayn-xxxxxxxxxxxxxxxx&lang=ar
```

يجب أن يكون الجهازان على الشبكة نفسها، وأن يسمح Windows Firewall لـNode.js بالاتصال على الشبكات الخاصة.

## 9. النشر الدائم

التشغيل المحلي يستخدم ذاكرة عملية Vite للحالة البعيدة. للنشر على Vercel أو منصة Serverless متعددة النسخ، أضف إلى متغيرات البيئة:

```text
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

وللترجمة المركزية:

```text
BROADCAST_TRANSLATION_BASE_URL=https://provider.example/v1
BROADCAST_TRANSLATION_API_KEY=...
BROADCAST_TRANSLATION_MODEL=...
```

لا تضع المفاتيح داخل Git أو الملفات المرفوعة إلى المستودع.
