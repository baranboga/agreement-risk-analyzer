# AI Engineer — roadmap.sh Eşleştirmeli 16 Haftalık Program

**Profil:** 3+ yıl frontend developer · Haftada 5-10 saat · Hedef: AI engineer olarak işe girmek
**Kaynak:** roadmap.sh/ai-engineer (PDF, doğrulanmış node yapısı)

> ✅ İyi haber: Roadmap'in **Pre-requisites** bölümü "Frontend / Backend / Full-Stack (one of these)" diyor. Frontend geçmişin, roadmap'in kendi tanımına göre geçerli bir giriş kapısı. Eksik bir şeyle başlamıyorsun.

---

## Roadmap'in dört yapısal zaafı

Node listesini okuduktan sonra net görülüyor:

1. **Ağır OpenAI bağımlılığı** — Platform, API, Assistant API, Moderation API, Vision API, DALL-E, Whisper, Functions/Tools. Neredeyse her uygulama node'u tek sağlayıcıya bağlı. Mülakatta "neden bu model, alternatifi ne?" sorulur.
2. **AI Agents bölümü çok zayıf** — sadece 5 node (Usecases, ReAct, Manual Implementation, Functions/Tools, Assistant API). 2026'da işe alımın en yoğun olduğu alan bu ve roadmap yüzeyde kalmış. Orchestration, hata toparlama, MCP, maliyet kontrolü hiç yok.
3. **Eval ve gözlemlenebilirlik hiç yok** — tek bir node bile. İşe alımdaki en ayırt edici konu.
4. **Production yok** — "Development Tools" başlığı altında sadece AI kod editörleri ve kod tamamlama araçları var. Deploy, caching, monitoring, maliyet kontrolü, fallback: sıfır.

Bu program o dört boşluğu kapatıyor.

| Etiket | Anlamı |
|---|---|
| 🔴 **Derinleş** | Mülakatta sorulur, proje üret |
| 🟡 **Çalışan bilgi** | Bir kere uygula, geç |
| ⚪ **Farkında ol** | 20 dakika oku, yeter |
| ⛔ **Atla** | Bu rol için gereksiz |

---

## Hafta 1 — Introduction + Using Pre-trained Models

| roadmap.sh node | Etiket |
|---|---|
| What is an AI Engineer? / AI Engineer vs ML Engineer | ⚪ |
| Roles and Responsibilities | ⚪ |
| Impact on Product Development | ⚪ |
| **Common Terminology:** LLMs, Inference, Training, Embeddings, Vector Databases, RAG, Prompt Engineering, AI Agents | 🟡 |
| AI vs AGI | ⛔ |
| Benefits of Pre-trained Models / Limitations and Considerations | 🟡 |
| **Popular AI Models:** OpenAI, Anthropic's Claude, Google's Gemini, Mistral AI, Cohere, Hugging Face Models | 🟡 |
| Capabilities / Context Length · Cut-off Dates / Knowledge | 🔴 |
| Azure AI · AWS Sagemaker | ⚪ |

**Çıktı:** Aynı promptu 3 farklı sağlayıcıya at (OpenAI + Claude + bir açık kaynak), cevap formatlarını ve maliyetlerini karşılaştıran küçük bir tablo çıkar. Roadmap'in OpenAI bağımlılığını daha ilk haftada kır.

> Common Terminology node'ları birer *kavram tanımı*. Hepsini ezberlemeye çalışma — zaten ilerideki haftalarda tek tek derinleşeceksin.

---

## Hafta 2-3 — Open AI Platform / OpenAI API → **Proje 1**

| roadmap.sh node | Etiket |
|---|---|
| Chat Completions API | 🔴 |
| Writing Prompts | 🔴 |
| Open AI Playground | 🟡 |
| **Managing Tokens:** Maximum Tokens, Token Counting, Pricing Considerations | 🔴 |
| Fine-tuning | ⚪ |
| Prompt Engineering Roadmap (ayrı roadmap) | 🟡 |

**Roadmap'te eksik, sen ekle:**
- **Structured output** (JSON schema ile zorunlu format) — üretimde en çok kullanılan şey, roadmap hiç bahsetmiyor
- **Streaming (SSE)** — frontend'ci olarak senin sahan
- **Tool / function calling döngüsü** — roadmap bunu Agents bölümüne saklamış ama temel API bilgisi

> Fine-tuning'i ⚪ yaptım çünkü giriş seviyesi işlerin %95'inde gerekmiyor. Doğru sıralama: prompt → RAG → fine-tune. Mülakatta "ne zaman fine-tune etmezsin?" diye sorulur, cevabı bilmen yeter.

**Proje 1: Odaklı AI web aracı** (genel chatbot değil, dar bir problem)
Şartlar: streaming + iptal edilebilir · structured output · 1 tool call döngüsü · API key backend'de · maliyet UI'da görünür.

---

## Hafta 4 — AI Safety and Ethics + OpenSource AI

| roadmap.sh node | Etiket |
|---|---|
| **Prompt Injection Attacks** | 🔴 |
| Security and Privacy Concerns | 🔴 |
| Constraining outputs and inputs | 🔴 |
| Robust prompt engineering | 🟡 |
| Conducting adversarial testing | 🟡 |
| OpenAI Moderation API | 🟡 |
| Adding end-user IDs in prompts | ⚪ |
| Know your Customers / Usecases | ⚪ |
| Bias and Fairness | ⚪ |
| Open vs Closed Source Models · Popular Open Source Models | 🟡 |
| Hugging Face Hub / Tasks / Finding Open Source Models | 🟡 |
| Ollama · Ollama Models · Ollama SDK | 🟡 → Hafta 5-6'ya taşındı |
| Inference SDK · Transformers.js | ⚪ |

**Çıktı:** Proje 1'e kendi prompt injection saldırını yap, savunmasını ekle, önce/sonra ölç.

> **Ollama Hafta 5-6'ya taşındı.** Hafta 4 injection ölçümüyle doldu; ayrıca Hafta 5-6'da zaten açık kaynak embedding modelleri (Sentence Transformers) var — local model çalıştırma tek oturumda birleşiyor.

> Güvenlik node'larının felsefi kısmını hafif geç, **prompt injection**'a odaklan. Bu gerçek bir mühendislik problemi ve agent yazmaya başladığında hayati hâle geliyor.

---

## Hafta 5-6 — Embeddings & Vector Databases

| roadmap.sh node | Etiket |
|---|---|
| What are Embeddings | 🔴 |
| Semantic Search | 🔴 |
| Recommendation Systems · Anomaly Detection · Data Classification | ⚪ |
| Open AI Embeddings API / Models / Pricing | 🟡 |
| Open-Source Embeddings: Sentence Transformers, Models on Hugging Face | 🟡 |
| **Ollama · Ollama Models · Ollama SDK** (Hafta 4'ten taşındı) | 🟡 |
| Vector Databases: Purpose and Functionality | 🔴 |
| **Popular Vector DBs (pick one)** → **pgvector (birincil) + Pinecone (karşılaştırma)** | 🔴 |
| Chroma · Pinecone · Weaviate · FAISS · LanceDB · Qdrant · MongoDB Atlas | ⚪ |
| Indexing Embeddings · Performing Similarity Search | 🔴 |

> Roadmap burada zaten **"pick one"** diyor ama biz bilinçli olarak ikisini de görüyoruz: **pgvector birincil** (Drizzle ORM üzerinden — tip güvenli, modern DX), **Pinecone karşılaştırma** (yönetilen servis deneyimi). Aynı veriyle ikisini de kurup farkı yaşayacaksın: pgvector'de veri tek yerde ve sorgular şeffaf; Pinecone'da kurulum sıfır ama veri ikiye bölünüyor ve senkronizasyon (doküman silinince vektörü de sil) senin sorumluluğun. Bu karşılaştırma mülakatta "X mi Y mi?" sorusunun hazır cevabı. Diğer 6 ismi tanı, yeter.

---

## Hafta 7-8 — RAG & Implementation → **Proje 2**

| roadmap.sh node | Etiket |
|---|---|
| RAG Usecases | 🟡 |
| **RAG vs Fine-tuning** | 🔴 |
| Chunking | 🔴 |
| Embedding → Vector Database → Retrieval Process → Generation | 🔴 |
| Using SDKs Directly | 🔴 |
| Langchain · Llama Index | 🟡 |
| Open AI Assistant API | ⚪ |
| Replicate | ⛔ |

**Roadmap'te eksik, sen ekle:** hybrid search (BM25 + vector), **reranking**, naive RAG'in neden çöktüğü (chunk sınırları, kayıp bağlam, çok atlamalı sorular). Roadmap RAG'i düz bir boru hattı gibi anlatıyor; gerçekte iş bu üç detayda.

> **"Using SDKs Directly" node'unu 🔴 yaptım, Langchain'i 🟡.** Roadmap ikisini eşit gösteriyor ama sıra önemli: önce elle yaz, sonra framework'e bak. Framework'ün neyi sakladığını görmen lazım.
>
> **Assistant API uyarısı:** Bildiğim kadarıyla OpenAI bu API'yi Responses API lehine emekliye ayırma sürecine aldı. Roadmap hem burada hem Agents bölümünde bu node'u tutuyor — güncel durumu OpenAI dokümanından doğrula, zaman harcamadan önce.

**Proje 2: RAG uygulaması + alıntı arayüzü**
Gerçek, dağınık doküman seti (toy dataset değil) · hybrid search + reranking · tıklanabilir kaynak alıntısı · "bilmiyorum" diyebilme · düzgün yükleme durumları.

---

## Hafta 9-10 — Eval & Gözlemlenebilirlik → **Proje 3** ⭐

> **Roadmap'te tek bir node bile yok. Programın en değerli kısmı bu.**

Roadmap seni RAG kurabilen biri yapar. Piyasada RAG kurabilen bol. **"Sisteminin doğruluğu ne?"** sorusuna sayıyla cevap verebilen az. Fark tam olarak burada.

**İçerik**
- Golden dataset (30-50 örnek, elle yaz — yeterli)
- LLM-as-judge: nasıl kurulur, nerede yanılır
- Deterministik metrikler vs. model tabanlı metrikler
- Regression testing: prompt değişince ne bozuldu?
- Tracing: Langfuse (açık kaynak) veya LangSmith
- **Python girişi** — eval script'lerini Python'da yaz. Dil öğrenmek için değil, iş yaparken öğren.

**Proje 3:** Proje 2'nin üstüne CI'da çalışan eval suite + metrik görselleştirme + 2 model karşılaştırması ve yazılı sonuç.

---

## Hafta 11-13 — AI Agents (genişletilmiş) → **Proje 4**

| roadmap.sh node | Etiket |
|---|---|
| Agents Usecases · RAG Alternative | 🟡 |
| Prompt Engineering (agent bağlamında) | 🟡 |
| **ReAct Prompting** | 🔴 |
| **Manual Implementation** | 🔴 |
| **OpenAI Functions / Tools** | 🔴 |
| OpenAI Assistant API | ⚪ (yukarıdaki emeklilik uyarısı) |

> **Roadmap'in en zayıf bölümü.** Toplam 5 node ile 2026'nın en yoğun alanını geçiştirmiş. Bu yüzden 3 hafta ayırdım ve aşağıdakileri ekledim:

**Roadmap'te eksik, sen ekle:**
- **MCP (Model Context Protocol)** — tool entegrasyonunda fiilî standart. Roadmap tamamen kaçırmış, ilanlarda görünüyor.
- Agent döngüsü mühendisliği: adım limiti, maliyet tavanı, sonsuz döngü koruması, retry
- Hata toparlama ve kısmi başarı yönetimi
- Bir orchestration framework'üne bakış (LangGraph veya muadili) — roadmap hiç bahsetmiyor
- **Agent UX** — trace arayüzü, durdurma, onay noktaları. Senin özel alanın; backend'den gelen adaylar bunu yapamıyor.

**Proje 4: Çok adımlı agent + kontrol paneli**
3+ tool (biri MCP üzerinden) · hata toparlama · adım/maliyet limiti · canlı trace UI · kritik aksiyonda insan onayı · Faz 3'teki eval yaklaşımı burada da uygulanmalı.

---

## Hafta 14 — Multimodal AI (hafif)

| roadmap.sh node | Etiket |
|---|---|
| Multimodal AI Usecases | ⚪ |
| Image Understanding · OpenAI Vision API | 🟡 |
| Speech-to-Text · Whisper API | 🟡 |
| Audio Processing · Text-to-Speech | ⚪ |
| Image Generation · DALL-E API | ⚪ |
| Video Understanding | ⛔ |
| Hugging Face Models (multimodal) | ⚪ |
| LangChain / LlamaIndex for Multimodal Apps | ⚪ |

**Çıktı:** Projelerinden birine görsel girdi ekle. Frontend'ci olarak "ekran görüntüsü → analiz" akışları senin için doğal.

> Roadmap bu bölüme 15+ node ayırmış — orantısız. Bir hafta yeter, giriş seviyesi ilanlarda nadiren belirleyici.

---

## Hafta 15-16 — Production

> **Roadmap'te yok.** "Development Tools" başlığı altında sadece **AI Code Editors** ve **Code Completion Tools** var — bunlar zaten günlük iş akışında öğrenilir, ayrı hafta gerektirmez.

**İçerik**
- Prompt caching + semantik cache, rate limit, retry/backoff
- Fallback zinciri: sağlayıcı down olursa ne olur
- PII maskeleme, tool yetki sınırları
- Maliyet kontrolü, kullanıcı bazlı kota
- Monitoring: latency p95, hata oranı, token/istek
- Deploy: Railway / Fly.io / Vercel

**Görev:** Proje 2 veya 4'ü gerçekten deploy et. Public URL, monitoring, maliyet tavanı.

---

## 🔧 Paralel hat: Backend açığını kapatma (Hafta 1-12, ~1.5 saat/hafta)

Roadmap "Pre-requisites" kısmında frontend'i kabul ediyor ama backend açığını nasıl kapatacağını söylemiyor. Frontend'den gelenlerin mülakatta elendiği yer burası.

| Hafta | Konu |
|---|---|
| 1-2 | **Drizzle + Postgres:** veri modelleme, migration, temel sorgular (Drizzle'ın API'si SQL'in tip güvenli izdüşümü — SQL düşünmeyi ORM konforuyla öğrenirsin) |
| 3-4 | Kendi backend'in: Node/Hono/Fastify, auth, validation, error handling |
| 5-6 | **pgvector (Drizzle üzerinden) + Pinecone:** aynı veriyle iki kurulum, metadata filtreleme, senkronizasyon farkları (Hafta 5-6 ile birleşir) |
| 7-8 | Docker + deploy |
| 9-10 | Queue & background jobs (BullMQ/Redis) — uzun agent işleri için şart |
| 11-12 | Log, metrik, tracing (eval fazıyla birleşir) |

---

## Hafta 17+ — İş Arama

**Portfolyo:** 2 derin proje, canlı ve kullanılabilir · README'de mimari kararlar + eval sonuçları + neyin çalışmadığı · 2 teknik yazı (sayılarla).

**Unvanlar:** AI Product Engineer · Applied AI Engineer · Full-stack AI Engineer · Forward Deployed Engineer. Saf ML Engineer ilanlarına başvurma.

**Mülakat:** LLM sistem tasarımı · RAG vs fine-tuning trade-off'u · agent maliyet kontrolü · **backend soruları** (en zorlanacağın yer) · frontend zaten güçlü tarafın.

---

## Roadmap'ten sapma özeti

| Değişiklik | Neden |
|---|---|
| ➕ **Eval fazı** (H9-10) | Roadmap'te sıfır node, işe alımda en kritik konu |
| ➕ **MCP** (H11-13) | Roadmap kaçırmış, ilanlarda görünüyor |
| ➕ **Agents 5 node → 3 hafta** | Roadmap'in en zayıf bölümü, piyasanın en yoğun alanı |
| ➕ **Production fazı** (H15-16) | Roadmap'te yok |
| ➕ **Structured output + streaming** | API bölümünde eksik, üretimde her gün kullanılıyor |
| ➕ **Hybrid search + reranking** | RAG'in gerçekte çalıştığı yer |
| ➕ **Backend paralel hattı** | Senin tek gerçek açığın |
| ➖ **8 vector DB → 2 (pgvector + Pinecone, karşılaştırmalı)** | Roadmap "pick one" diyor; biz iki mimari yaklaşımı da deneyimlemek için ikisini seçtik |
| ➖ **Multimodal 15 node → 1 hafta** | Giriş için orantısız |
| ➖ **AI vs AGI, Video Understanding, Replicate** | Bu rolde sorulmaz |
| 🔄 **OpenAI-merkezlilik kırıldı** | Çok sağlayıcı bilmek mülakatta artı |
| ⚠️ **Assistant API düşürüldü** | Emeklilik sürecinde — doğrula |
