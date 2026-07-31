-- ============================================================
-- Migration 021: Seed 20 email/DM templates (batch 8e-P0 / T3)
-- ============================================================
-- 4 categories x 5 languages = 20 templates. Each row holds:
--   - subject (email subject; ignored on DM platforms)
--   - body    (plain text with {{variable}} placeholders)
--   - variant (vertical tag, optional)
--
-- Variables (the portal does a one-shot replace before send):
--   {{kol_name}}      — KOL display name
--   {{prospect_name}} — first name / handle the KOL types in
--   {{case_link}}     — LCM case-study URL
--   {{booking_link}}  — LCM pre-review form URL
--   {{referral_link}} — KOL's referral URL with UTM tags
-- ============================================================

-- ============================== EN ==============================

INSERT INTO affiliate.email_templates
  (category, language, title, subject, body, variant)
VALUES
(
  'dm_invite', 'en',
  'Cold DM — Fertility (curious follower)',
  'A quick intro from {{kol_name}}',
  E'Hi {{prospect_name}},\n\nI noticed you''ve been asking about IVF options — that''s exactly the space I cover.\n\nI work with LinkChinaMed to help international patients compare fertility clinics in China (top success rates, English-speaking care). If you''re just gathering info, here''s one short article that lays out the typical process + cost ranges:\n{{case_link}}\n\nNo pressure at all — happy to answer questions in DMs.\n\n{{kol_name}}',
  'fertility'
),
(
  'follow_up', 'en',
  'Day-1 check-in after first DM',
  'Following up — {{kol_name}}',
  E'Hi {{prospect_name}},\n\nThanks for the chat yesterday. As promised, here''s the link to start a free pre-review with the LinkChinaMed team:\n{{booking_link}}\n\nIt''s a short form (5 min) — they''ll come back within 48 hours with a specialist match + cost estimate. No commitment.\n\nReply here any time.\n\n{{kol_name}}',
  NULL
),
(
  'service_pitch', 'en',
  'Why LinkChinaMed — short value pitch',
  'A 60-second read on what LCM actually does',
  E'Hi {{prospect_name}},\n\nYou asked what makes LinkChinaMed different from a hospital website. Quick version:\n\n• Coordination, not treatment — they book the right specialist, handle records, and translate for you\n• Top-tier hospitals only (Fuwai, Ruijin, PUMC, etc.)\n• Fixed-fee bundles, no surprise bills\n• English-speaking case manager from day 1\n\nIf you want, I can send you one anonymised case from a patient similar to you:\n{{case_link}}\n\n{{kol_name}}',
  NULL
),
(
  'case_share', 'en',
  'Anonymised fertility case (US → CN)',
  'A fertility case that might feel familiar',
  E'Hi {{prospect_name}},\n\nSharing one case I often reference — names anonymised, with the patient''s consent:\n\n38-year-old from California, two prior failed IVF cycles in the US. Pre-review done in 5 days; specialist matched in a week. Successful embryo transfer on the second cycle.\n\nFull write-up: {{case_link}}\n\nIf anything in there resonates, I''m here.\n\n{{kol_name}}',
  'fertility'
),

-- ============================== ZH ==============================

(
  'dm_invite', 'zh',
  '冷启动私信——生育方向',
  '{{kol_name}} 的一条简短自我介绍',
  E'你好 {{prospect_name}},\n\n看到你最近在问试管婴儿(IVF)的相关话题,正好是我专注的方向。\n\n我与 LinkChinaMed(链接中华医疗)合作,帮海外患者对接国内头部生殖中心(成功率高、有中文/英文双语支持)。如果你还在收集信息,推荐先看这一篇 5 分钟的科普:\n{{case_link}}\n\n不一定要立刻决定,有问题随时私信我就好。\n\n{{kol_name}}',
  'fertility'
),
(
  'follow_up', 'zh',
  '首次私信后第 1 天回访',
  '回访一下——{{kol_name}}',
  E'你好 {{prospect_name}},\n\n感谢昨天的交流。答应你的免费分诊链接:\n{{booking_link}}\n\n填表大约 5 分钟,LinkChinaMed 团队会在 48 小时内匹配专科医生 + 给出费用区间。无任何承诺。\n\n随时回复。\n\n{{kol_name}}',
  NULL
),
(
  'service_pitch', 'zh',
  'LinkChinaMed 是什么——60 秒讲清',
  '一文讲清楚 LinkChinaMed 到底是做什么的',
  E'你好 {{prospect_name}},\n\n你之前问 LinkChinaMed 和医院官网有什么不同。简单讲:\n\n• 我们做的是"协调",不是治疗——帮你挂对专家、整理病历、双语翻译\n• 只对接头部医院(阜外、瑞金、协和等)\n• 套餐制,无隐藏费用\n• 从第一天起就有中文/英文双语顾问\n\n如果想看一个真实匿名案例(类似你的情况):\n{{case_link}}\n\n{{kol_name}}',
  NULL
),
(
  'case_share', 'zh',
  '匿名生育案例(美国 → 中国)',
  '一个可能跟你很像的案例',
  E'你好 {{prospect_name}},\n\n分享一个我常引用的匿名案例(已获患者授权):\n\n美国加州 38 岁女性,此前在美国做过两次 IVF 均失败。LinkChinaMed 5 天完成分诊,一周内匹配专家,第二次胚胎移植成功,9 个月后顺利生产。\n\n完整内容: {{case_link}}\n\n如果有任何共鸣,欢迎随时找我。\n\n{{kol_name}}',
  'fertility'
),

-- ============================== ES ==============================

(
  'dm_invite', 'es',
  'Primer DM — Fecundidad (seguidor curioso)',
  'Una breve presentación de {{kol_name}}',
  E'Hola {{prospect_name}},\n\nVi que estabas preguntando sobre opciones de FIV — justo es el tema que cubro.\n\nTrabajo con LinkChinaMed para ayudar a pacientes internacionales a comparar clínicas de fertilidad en China (altas tasas de éxito, atención en español/inglés). Si solo estás recopilando información, aquí tienes un artículo corto con el proceso y los rangos de costo típicos:\n{{case_link}}\n\nSin presión — con gusto respondo preguntas por DM.\n\n{{kol_name}}',
  'fertility'
),
(
  'follow_up', 'es',
  'Seguimiento día 1 tras el primer DM',
  'Solo un seguimiento — {{kol_name}}',
  E'Hola {{prospect_name}},\n\nGracias por la conversación de ayer. Como prometí, aquí tienes el enlace para iniciar una pre-revisión gratuita con el equipo de LinkChinaMed:\n{{booking_link}}\n\nEs un formulario corto (5 min) — responden en 48 horas con un especialista y un rango de costo. Sin compromiso.\n\nResponde cuando quieras.\n\n{{kol_name}}',
  NULL
),
(
  'service_pitch', 'es',
  'Por qué LinkChinaMed — versión corta',
  'Una lectura de 60 segundos sobre lo que hace LCM',
  E'Hola {{prospect_name}},\n\nMe preguntaste qué hace diferente a LinkChinaMed de una página web de un hospital. Versión corta:\n\n• Coordinación, no tratamiento — reservamos al especialista correcto, gestionamos el historial y traducimos\n• Solo hospitales de primer nivel (Fuwai, Ruijin, PUMC, etc.)\n• Paquetes de tarifa fija, sin sorpresas\n• Gestor de casos en español/inglés desde el día 1\n\nSi quieres, te envío un caso anonimizado de un paciente similar:\n{{case_link}}\n\n{{kol_name}}',
  NULL
),
(
  'case_share', 'es',
  'Caso anonimizado de fecundidad (US → CN)',
  'Un caso de fecundidad que quizá te resulte familiar',
  E'Hola {{prospect_name}},\n\nComparto un caso que suelo citar — nombres anonimizados, con consentimiento del paciente:\n\nMujer de 38 años de California, dos ciclos previos de FIV sin éxito en EE. UU. Pre-revisión completada en 5 días; especialista asignado en una semana. Transferencia embrionaria exitosa en el segundo ciclo.\n\nDetalle completo: {{case_link}}\n\nSi algo resuena contigo, aquí estoy.\n\n{{kol_name}}',
  'fertility'
),

-- ============================== AR ==============================

(
  'dm_invite', 'ar',
  'رسالة باردة — الخصوبة',
  'تعريف سريع من {{kol_name}}',
  E'مرحبًا {{prospect_name}},\n\nلاحظت أنك تسأل عن خيارات أطفال الأنابيب (IVF) — وهذا بالضبط مجالي.\n\nأعمل مع LinkChinaMed لمساعدة المرضى الدوليين على مقارنة عيادات الخصوبة في الصين (نتائج عالية، فريق يتحدث العربية/الإنجليزية). إذا كنت فقط تجمع معلومات، فإليك مقالًا قصيرًا يوضح العملية ونطاقات التكلفة المعتادة:\n{{case_link}}\n\nبدون أي ضغط — يسعدني الإجابة على أسئلتك في الرسائل.\n\n{{kol_name}}',
  'fertility'
),
(
  'follow_up', 'ar',
  'متابعة في اليوم الأول بعد أول رسالة',
  'متابعة من {{kol_name}}',
  E'مرحبًا {{prospect_name}},\n\nشكرًا على المحادثة بالأمس. كما وعدتك، إليك الرابط لبدء مراجعة مجانية مع فريق LinkChinaMed:\n{{booking_link}}\n\nنموذج قصير (5 دقائق) — سيردون خلال 48 ساعة بتخصص مناسب ونطاق تكلفة. بدون التزام.\n\nرد في أي وقت.\n\n{{kol_name}}',
  NULL
),
(
  'service_pitch', 'ar',
  'لماذا LinkChinaMed — عرض سريع',
  'قراءة في 60 ثانية عن ما تفعله LCM فعلًا',
  E'مرحبًا {{prospect_name}},\n\nسألتني ما الذي يميّز LinkChinaMed عن موقع المستشفى. بإيجاز:\n\n• تنسيق لا علاج — نحجز الاختصاصي المناسب ونجهّز التقارير ونترجم\n• مستشفيات من الدرجة الأولى فقط (Fuwai، Ruijin، PUMC ...)\n• باقات بسعر ثابت، لا مفاجآت\n• مدير حالة بالعربية/الإنجليزية من اليوم الأول\n\nإن أردت، أرسل لك حالة مجهولة الهوية لمريض مشابه:\n{{case_link}}\n\n{{kol_name}}',
  NULL
),
(
  'case_share', 'ar',
  'حالة خصوبة مجهولة (أمريكا ← الصين)',
  'حالة خصوبة قد تشبه وضعك',
  E'مرحبًا {{prospect_name}},\n\nأشاركك حالة أعود إليها كثيرًا — الأسماء مستبدلة، بإذن المريضة:\n\nامرأة عمرها 38 من كاليفورنيا، دورتا أطفال أنابيب فاشلتين في أمريكا. اكتملت المراجعة الأولية خلال 5 أيام؛ واختُصص لها الطبيب خلال أسبوع. نجح نقل الأجنة في الدورة الثانية.\n\nالتفاصيل: {{case_link}}\n\nإن شعرت بأي قاسم، أنا هنا.\n\n{{kol_name}}',
  'fertility'
),

-- ============================== RU ==============================

(
  'dm_invite', 'ru',
  'Холодное сообщение — фертильность',
  'Краткое знакомство от {{kol_name}}',
  E'Привет, {{prospect_name}},\n\nЗаметил(а), что ты интересуешься ЭКО — это как раз моя тема.\n\nЯ сотрудничаю с LinkChinaMed и помогаю иностранным пациентам сравнивать клиники фертильности в Китае (высокие показатели, англо-/русскоязычная поддержка). Если ты только собираешь информацию, вот короткая статья с описанием процесса и ориентировочных цен:\n{{case_link}}\n\nБез давления — готова(а) ответить на вопросы в личке.\n\n{{kol_name}}',
  'fertility'
),
(
  'follow_up', 'ru',
  'Повторный контакт через 1 день',
  'Повторное сообщение — {{kol_name}}',
  E'Привет, {{prospect_name}},\n\nСпасибо за вчерашний разговор. Как обещала(а), вот ссылка на бесплатный предварительный обзор от команды LinkChinaMed:\n{{booking_link}}\n\nКороткая форма (5 минут) — ответят в течение 48 часов с подбором специалиста и ориентировочной стоимостью. Никаких обязательств.\n\nОтвечай в любое время.\n\n{{kol_name}}',
  NULL
),
(
  'service_pitch', 'ru',
  'Зачем нужен LinkChinaMed — кратко',
  '60 секунд о том, чем LCM реально полезен',
  E'Привет, {{prospect_name}},\n\nТы спрашивал(а), чем LinkChinaMed отличается от сайта больницы. Коротко:\n\n• Координация, а не лечение — подбираем специалиста, оформляем документы, переводим\n• Только ведущие клиники (Fuwai, Ruijin, PUMC и т. д.)\n• Фиксированные пакеты без скрытых платежей\n• Русско-/англоязычный кейс-менеджер с первого дня\n\nЕсли хочешь, пришлю анонимный кейс пациента с похожей ситуацией:\n{{case_link}}\n\n{{kol_name}}',
  NULL
),
(
  'case_share', 'ru',
  'Анонимный кейс по фертильности (США → КНР)',
  'Кейс по фертильности, который может быть близок',
  E'Привет, {{prospect_name}},\n\nДелюсь кейсом, к которому часто обращаюсь — имена изменены, с согласия пациентки:\n\nЖенщина, 38 лет, Калифорния, две неудачные попытки ЭКО в США. Предварительный обзор — за 5 дней; специалист подобран за неделю. Успешный перенос эмбриона во второй попытке.\n\nПодробности: {{case_link}}\n\nЕсли что-то откликается — пиши.\n\n{{kol_name}}',
  'fertility'
)
;

NOTIFY pgrst, 'reload schema';
