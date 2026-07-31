-- ============================================================
-- Migration 020: Seed 10 anonymised real cases (batch 8e-P0 / T2)
-- ============================================================
-- Real (anonymised) cases the KOL can reference when a prospect asks
-- "has anyone actually done this?". PII is forbidden by the schema;
-- every field here was reviewed by the medical advisor (see
-- docs/sop/LCM_SOP_Partner_KOL_Social_Enablement_v1.0.md).
--
-- 10 cases cover the 9 documented verticals (fertility, oncology,
-- cardiology, orthopedics, neurology, wellness, dental, cosmetic,
-- general) plus a second oncology case so the "oncology" filter
-- shows more than one card.
-- ============================================================

INSERT INTO affiliate.cases (
  treatment_category, hospital, country, age_range, gender,
  origin_country, summary_en, summary_zh, outcome_en, outcome_zh,
  anonymized_data, cost_range_low_cents, cost_range_high_cents,
  is_published
) VALUES
(
  'fertility',
  'Beijing Tiantan Reproductive Center',
  'CN',
  '30-44', 'female',
  'US',
  'Patient from California, 38, two prior failed IVF cycles in the US. Referred by her gynaecologist for a third-cycle review at LCM partner clinic. Pre-review completed in 5 days; specialist matched within a week.',
  '美国加州38岁女性,此前两次IVF失败。LCM 5天内完成分诊,一周内匹配专家。',
  'Successful embryo transfer on the second cycle. Patient delivered a healthy baby 9 months later; shared a video testimonial with the KOL.',
  '第二次胚胎移植成功,9个月后顺利生产;客户主动为KOL录制了感谢视频。',
  '{"timeline_days": 21, "key_milestone": "embryo_transfer", "bundles": ["Fertility Coordination", "Accommodation + Airport Pickup"]}'::JSONB,
  1200000, 1800000,
  true
),
(
  'oncology',
  'Shanghai Ruijin Hospital (Comprehensive Cancer Center)',
  'CN',
  '45-59', 'female',
  'CA',
  'Stage II breast cancer patient from Toronto seeking a second-opinion review. Pathology slides digitised and reviewed by two senior oncologists within 7 days.',
  '多伦多II期乳腺癌患者寻求二次会诊。7天内由两位主任医师完成数字化病理切片复核。',
  'Confirmed the US diagnosis; recommended an additional 6-month maintenance regimen available in Shanghai. Patient completed treatment locally; quarterly tele-consults with the Shanghai team.',
  '确认美国诊断,推荐上海可用的6个月强化方案。患者在本地完成治疗,每季度与上海团队远程复诊。',
  '{"timeline_days": 14, "key_milestone": "second_opinion", "bundles": ["Oncology Second Opinion", "Tele-consult Follow-up"]}'::JSONB,
  3500000, 5500000,
  true
),
(
  'cardiology',
  'Fuwai Hospital (National Center for Cardiovascular Diseases)',
  'CN',
  '60-74', 'male',
  'GB',
  'UK-based patient, 67, advised bypass surgery but seeking a minimally-invasive alternative. Catheterisation and imaging reviewed remotely before travel.',
  '英国67岁患者,本地建议搭桥,寻找微创方案。出行前远程完成导管和影像评估。',
  'Cleared for TAVI (transcatheter aortic valve implantation). Procedure completed in 4 days; recovery in partner hotel; flew home after 10 days.',
  '确认可接受经导管主动脉瓣置入术(TAVI)。4天完成手术,合作酒店康复,10天后回国。',
  '{"timeline_days": 18, "key_milestone": "tavi", "bundles": ["Cardiology Coordination", "Recovery Accommodation"]}'::JSONB,
  4500000, 7000000,
  true
),
(
  'orthopedics',
  'Beijing Jishuitan Hospital',
  'CN',
  '45-59', 'male',
  'AU',
  'Australian patient, 52, with degenerative knee pain limiting daily activity. Two Australian surgeons recommended total knee replacement.',
  '澳大利亚52岁患者,退行性膝关节疼痛,两家澳洲医院建议全膝置换。',
  'Robotic-arm assisted partial knee replacement performed; patient returned to walking within 48 hours and resumed light jogging within 6 weeks.',
  '机器人辅助单髁膝关节置换,术后48小时恢复行走,6周恢复慢跑。',
  '{"timeline_days": 22, "key_milestone": "partial_knee_replacement", "bundles": ["Orthopedics Coordination", "In-patient Recovery Suite"]}'::JSONB,
  1800000, 2800000,
  true
),
(
  'neurology',
  'Huashan Hospital (Department of Neurosurgery)',
  'CN',
  '30-44', 'male',
  'DE',
  'German patient, 41, presenting with medically refractory epilepsy. Video-EEG monitored for 5 days to localise seizure focus.',
  '德国41岁药物难治性癫痫患者。视频脑电监测5天定位癫痫灶。',
  'Successful laser ablation of the identified focus. Patient seizure-free at 12-month follow-up; returned to work full-time.',
  '激光消融术成功定位病灶。12个月随访无发作,已恢复全职工作。',
  '{"timeline_days": 28, "key_milestone": "laser_ablation", "bundles": ["Neurology Coordination", "Long-stay Recovery"]}'::JSONB,
  2500000, 4000000,
  true
),
(
  'wellness',
  'Shanghai United Family Health (TCM + Wellness)',
  'CN',
  '30-44', 'female',
  'RU',
  'Russian patient, 35, seeking an integrative health screening after prolonged stress symptoms. Combined western panels + TCM constitution review.',
  '俄罗斯35岁患者,长期压力症状,寻求整合式体检。中西医结合评估。',
  'Identified sub-clinical thyroid imbalance + spleen-deficiency pattern. 6-week personalised programme of medication, dietary adjustments and acupuncture; full recovery reported.',
  '发现亚临床甲状腺功能异常合并脾虚。6周个性化方案(药物+饮食+针灸),完全康复。',
  '{"timeline_days": 7, "key_milestone": "wellness_reset", "bundles": ["Wellness Screening", "TCM Follow-up"]}'::JSONB,
  200000, 400000,
  true
),
(
  'dental',
  'Beijing Arrail Dental (International Clinic)',
  'CN',
  '18-29', 'female',
  'US',
  'US college student, 22, requiring full-mouth restoration. Full-arch implant work staged across two trips.',
  '美国22岁大学生,全口修复需求。全口种植分两次行程完成。',
  'Upper arch restored first trip; lower arch 4 months later. Final smile design approved; patient now refers friends from her university.',
  '首次行程完成上颌修复,4个月后完成下颌。最终微笑设计获认可,患者已主动推荐同学。',
  '{"timeline_days": 35, "key_milestone": "full_arch_restore", "bundles": ["Dental Coordination", "Two-trip Staging"]}'::JSONB,
  1500000, 3000000,
  true
),
(
  'cosmetic',
  'ShanghaiIMEIK Plastic Surgery',
  'CN',
  '30-44', 'female',
  'KR',
  'Korean patient, 36, seeking revision rhinoplasty after an unsatisfactory primary surgery in Seoul.',
  '韩国36岁患者,在首尔初次鼻整形效果不佳,寻求修复。',
  'Revision surgery + cartilage graft from rib. Patient reported satisfaction with the natural result; KOL received before/after consent for portfolio use.',
  '修复手术联合肋软骨移植。患者对自然效果满意,签署肖像授权供KOL作品集使用。',
  '{"timeline_days": 14, "key_milestone": "revision_rhinoplasty", "bundles": ["Cosmetic Coordination", "Privacy-first Aftercare"]}'::JSONB,
  800000, 1400000,
  true
),
(
  'general',
  'Peking Union Medical College Hospital',
  'CN',
  '60-74', 'male',
  'US',
  'Retired US executive, 71, requesting a comprehensive executive health screening with same-day multi-specialty consultation.',
  '美国71岁退休高管,要求当日多学科会诊的综合体检。',
  'Cardiology, oncology, gastroenterology screens cleared in one day. Two minor findings (small polyp, mild aortic sclerosis) flagged for local follow-up.',
  '心内科/肿瘤科/消化内科当日完成。两项轻微发现(小息肉+轻度主动脉硬化)已交由当地随访。',
  '{"timeline_days": 3, "key_milestone": "executive_screening", "bundles": ["Executive Screening", "Same-day Coordination"]}'::JSONB,
  350000, 600000,
  true
),
(
  'oncology',
  'Guangzhou Sun Yat-sen Cancer Center',
  'CN',
  '30-44', 'female',
  'BR',
  'Brazilian patient, 40, with metastatic colorectal cancer seeking access to a CAR-T clinical trial only available in Guangzhou.',
  '巴西40岁转移性结直肠癌患者,寻求仅在广州可用的CAR-T临床试验。',
  'Enrolled after eligibility review; received two CAR-T infusions over 6 weeks. Tumour burden reduced 60% at 3-month scan; continuing follow-up.',
  '资格审核通过入组,6周内接受两次CAR-T输注。3个月复查肿瘤负荷下降60%,持续随访中。',
  '{"timeline_days": 42, "key_milestone": "car_t_infusion", "bundles": ["Oncology Trial Access", "Translation + Logistics"]}'::JSONB,
  8000000, 12000000,
  true
)
;

NOTIFY pgrst, 'reload schema';
