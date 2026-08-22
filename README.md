# Sözleşme Risk Tarayıcısı

Next.js 15 (App Router) + TypeScript ile, **tek sağlayıcı (OpenAI)** kullanan,
öğrenme amaçlı bir sözleşme risk analiz aracı. Bilerek framework/SDK soyutlaması
**yok**: LLM çağrısı ham `fetch` ile yazıldı, SSE elle ayrıştırıldı, tool
döngüsü açıkça bir `while` ile yürütülüyor.

---

## Kurulum

```bash
# 1) Bağımlılıklar
npm install

# 2) Ortam değişkeni
cp .env.example .env        # PowerShell: Copy-Item .env.example .env
# .env içine kendi OPENAI_API_KEY değerinizi yazın

# 3) Geliştirme sunucusu
npm run dev
# http://localhost:3000
```

> **Not:** `OPENAI_API_KEY` yalnızca sunucuda okunur. İsmi bilerek
> `NEXT_PUBLIC_` ile başlamıyor; bu sayede Next.js anahtarı client bundle'ına
> koymaz, tarayıcıya sızmaz.

---

## Dosya yapısı

```
app/
  layout.tsx              Kök layout
  page.tsx                Arayüz: giriş, mod/model seçimi, canlı gösterge,
                          akan kartlar, Durdur (AbortController)
  globals.css            Düz CSS (framework yok)
  api/analyze/route.ts   POST + SSE. Tool döngüsü ve maliyet hesabı burada.
lib/
  llm.ts                 OpenAI'a ÖZEL her şey: streaming fetch + SSE parse
  schema.ts              zod şeması + OpenAI json_schema (strict) üretici
  tools.ts               sureHesapla + tool tanımı + dağıtıcı
  cost.ts                Fiyat tablosu (tek sabit obje) + USD hesabı
  partial.ts             MOD B: yarım JSON'dan tamamlanan maddeleri ayıklama
  protocol.ts            Sunucu→istemci SSE olay tipleri (ortak sözleşme)
```

---

## Mimari kararlar

### 1. Sağlayıcıya özel her şey tek dosyada (`lib/llm.ts`)
OpenAI'a özgü URL, header, body şekli ve **SSE chunk formatının çözümlenmesi**
sadece burada. İleride başka sağlayıcıya geçilecekse route ve UI'a dokunmadan
yalnızca bu dosya değişir. SDK kullanılmadı; `openAICagir` ham `Response`
döndürür, `openAIParcalariniOku` ise ham SSE'yi anlamlı parçalara çevirir.

### 2. Tool döngüsü elle, açıkça (`route.ts`)
`while (tur < MAKS_TUR)` (maks. 3 tur). Her turda:
1. OpenAI çağrılır, akış okunur.
2. `finish_reason === "tool_calls"` ise: tool'lar çalıştırılır, `assistant`
   (tool_calls) ve `tool` (sonuç) mesajları geçmişe eklenir, **başa dönülür**.
3. `finish_reason === "stop"` ise: nihai JSON hazırdır, çıkılır.

Tool çağrılarının argümanları streaming'de **parça parça** gelir; `index`'e
göre birleştirilir (`toolCallBirikim`).

### 3. İki streaming modu (UI'dan seçilir)
- **MOD A** — İçerik birikir, akış **bitince** tek seferde `JSON.parse` + zod ile
  doğrulanır. Basit ve güvenli; ama kullanıcı sonuna kadar kart görmez.
- **MOD B** — Her delta'da yarım JSON tolere edilir (`lib/partial.ts`).
  **Nasıl:** metni karakter karakter tarayıp `maddeler` dizisi içinde süslü
  parantez derinliğini ve string/kaçış durumunu takip ederiz. Bir nesne
  derinlik 0'a döndüğünde **eksiksiz** tamamlanmıştır; yalnızca o parça parse
  edilip karta dönüşür. Yarım kalan son nesne yok sayılır → kartlar titremeden
  akar. (Yarım metni zorla kapatıp parse etme numarasına gerek kalmaz.)

### 4. Token & maliyet (`lib/cost.ts`)
Fiyatlar **tek** sabit objede (`FIYATLAR`), 1M token başına USD. Prompt ve
completion ayrı çarpanlarla hesaplanır. OpenAI streaming sırasında ara token
sayısı vermez; **kesin** usage yalnızca akışın sonunda gelir
(`stream_options.include_usage`). Bu yüzden akarken **~4 karakter ≈ 1 token**
kaba tahmini gösterilir (“tahmini” rozeti), akış bitince API'nin verdiği kesin
sayılarla değiştirilir (“kesin” rozeti). Tur'lar arası token'lar toplanır.

### 5. İptal (Durdur) uçtan uca
Client `AbortController.abort()` → fetch iptal → aynı `signal` sunucuda
`req.signal` olarak upstream OpenAI fetch'ine geçtiği için **upstream istek de
gerçekten abort** olur. İptalde client hiçbir şeyi sıfırlamaz; o ana kadarki
(tahmini) token/maliyet ekranda kalır.

### 6. Hata kategorileri (üçü ayrı)
- **rate_limit** — HTTP 429; “bekleyip tekrar deneyin”.
- **gecersiz_json** — model geçerli JSON üretemedi (sunucu güvenlik ağı) veya
  şemaya uymadı (client mod A'da zod ile yakalanır).
- **tool_hatasi** — tool çalışırken hata; kullanıcıya gösterilir **ve** modele
  geri verilir ki bir sonraki turda düzeltebilsin.

### 7. Structured output (strict) ↔ zod
`lib/schema.ts` iki temsili elle yakın tutar: zod (çalışma zamanı doğrulaması)
ve OpenAI `json_schema` (`strict: true`). Strict mod her nesnede
`additionalProperties: false` ve **tüm** alanların `required` olmasını ister;
“opsiyonel” yoktur. Bu yüzden `sureIfadesi` nullable (`["string","null"]`) yapılıp
yine `required`'a konur.

### Bilinen sınırlama — `sureHesapla`
İş günü (“is”) modunda **yalnızca hafta sonlarını** atlar; **Türkiye resmi
tatillerini bilmez** (23 Nisan, 29 Ekim, dini bayramlar vb. iş günü sayılır).
Sonuç gerçek yasal süreden birkaç gün sapabilir. Kritik hesaplarda tek başına
güvenilmemeli. (Ayrıntı kod yorumunda.)

---

## Sonuçlar ve Ölçümler

<!-- Bu bölüm bilerek boş bırakıldı; ölçümlerinizi buraya siz ekleyeceksiniz. -->
