// lib/schema.ts
// -----------------------------------------------------------------------------
// Çıktı şeması iki biçimde tanımlı:
//   1) zod ile -> ÇALIŞMA ZAMANI doğrulaması (client mod A'da JSON'u doğrularız)
//   2) OpenAI json_schema (strict) -> MODELİN çıktısını şemaya ZORLAMAK için
//
// İkisini elle birbirine yakın tuttum. "zod'dan otomatik üretsem?" diye
// düşünülebilir ama OpenAI'ın strict modunun kendine has katı kuralları var
// (aşağıda açıkladım). Öğrenme amaçlı olduğu için elle yazmak daha nettir.
// -----------------------------------------------------------------------------

import { z } from "zod";

// Risk seviyesi sabit üçlü. Türkçe değerler (istenildiği gibi).
export const RiskSeviyesi = z.enum(["dusuk", "orta", "yuksek"]);

// Tek bir sözleşme maddesi / risk bulgusu.
export const MaddeSchema = z.object({
  alinti: z.string(), // sözleşmeden birebir (kısa) alıntı
  riskSeviyesi: RiskSeviyesi, // "dusuk" | "orta" | "yuksek"
  gerekce: z.string(), // bu madde neden riskli
  oneri: z.string(), // nasıl düzeltilmeli / neye dikkat edilmeli
  // sureIfadesi opsiyonel: bir süreye/tarihe bağlı madde ise doldurulur.
  // OpenAI strict modu "opsiyonel"i sevmediği için (aşağıya bak) modelden
  // hep alan gelir ama null olabilir -> nullable().
  sureIfadesi: z.string().nullable().optional(),
});

// Tüm analiz çıktısı: madde listesi.
export const AnalizSchema = z.object({
  maddeler: z.array(MaddeSchema),
});

export type Madde = z.infer<typeof MaddeSchema>;
export type Analiz = z.infer<typeof AnalizSchema>;

// -----------------------------------------------------------------------------
// OpenAI "structured output" (response_format) için json_schema üretir.
//
// strict:true modunun KATI kuralları (bunlara uymazsan OpenAI hata verir):
//   - Her object'te "additionalProperties": false olmalı.
//   - Bir object'in TÜM property'leri "required" içinde olmalı.
//     -> "opsiyonel alan" diye bir şey yoktur. Opsiyonel istediğimizi
//        NULLABLE yaparak çözeriz: tip ["string","null"] + yine required.
//        (Bu yüzden sureIfadesi burada nullable ve required.)
// -----------------------------------------------------------------------------
export function analizJsonSchema() {
  return {
    name: "sozlesme_analizi",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        maddeler: {
          type: "array",
          description: "Sözleşmede tespit edilen riskli maddelerin listesi.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              alinti: {
                type: "string",
                description: "Sözleşmeden birebir kısa alıntı.",
              },
              riskSeviyesi: {
                type: "string",
                enum: ["dusuk", "orta", "yuksek"],
                description: "Maddenin risk seviyesi.",
              },
              gerekce: {
                type: "string",
                description: "Bu maddenin neden riskli olduğu.",
              },
              oneri: {
                type: "string",
                description: "Riski azaltmak için öneri.",
              },
              sureIfadesi: {
                // strict modda opsiyonel yok -> nullable string
                type: ["string", "null"],
                description:
                  "Madde bir süreye bağlıysa süre/son tarih notu; değilse null.",
              },
            },
            required: [
              "alinti",
              "riskSeviyesi",
              "gerekce",
              "oneri",
              "sureIfadesi",
            ],
          },
        },
      },
      required: ["maddeler"],
    },
  } as const;
}
