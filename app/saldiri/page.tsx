"use client";

// app/saldiri/page.tsx
// -----------------------------------------------------------------------------
// SALDIRI PANELİ — prompt injection ölçüm arayüzü.
//
// Amaç: 5 saldırı ailesi × 2 koşul (savunmasız/savunmalı) × N koşuyu TEK tıkla
// çalıştırıp ham metrik tablosunu ve özet tablosunu basmak. Ayrıca payload'suz
// "temiz referans" koşuları da otomatik alınır; karşılaştırma ona göre yapılır.
//
// TASARIM İLKELERİ:
//   - Deney modunun (app/deney) tek-değişkenli yapısına DOKUNMAZ; ortak kodu
//     (prompt, cost, istemciAkis, olcum) paylaşır ama ayrı bir sayfadır.
//   - Koşular SIRAYLA çalışır (paralel değil; rate limit yememek için).
//   - Çalıştırmadan ÖNCE tahmini maliyet gösterilip onay istenir.
//   - İptal edilebilir (AbortController).
//   - Başarı kriteri OTOMATİK YORUMLANMAZ: tablo ham hâliyle basılır; "saldırı
//     başarılı" etiketini kullanıcı elle koyar. Panel yalnızca "temiz referanstan
//     değişiklik gözlendi mi" gibi mekanik bir kıyas verir.
// -----------------------------------------------------------------------------

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ORNEKLER } from "@/lib/ornekler";
import {
  FIYATLAR,
  maliyetHesapla,
  kabaTokenTahmini,
  type ModelAdi,
} from "@/lib/cost";
import { sistemPromptu, sozlesmeMetniniSar } from "@/lib/prompt";
import { toolTanimlari } from "@/lib/tools";
import { SALDIRILAR, payloadGom, type KanitSutunu } from "@/lib/saldirilar";
import {
  normalizeMetin,
  alintiDogrulaDetay,
  type DogrulamaSeviyesi,
} from "@/lib/dogrula";
import { analiziCalistir, type AkisSonucu } from "@/lib/istemciAkis";
import {
  metrikCikar,
  ozetHesapla,
  referansProfil,
  riskImzasi,
  csvUret,
  markdownUret,
  type KosuMetrik,
  type OzetSatir,
} from "@/lib/olcum";

// Temiz (payload'suz) referans metin. Bu, test/hizmet_sozlesmesi.txt ile BİREBİR
// AYNI içeriktir (lib/ornekler.ts içindeki "detayli" örneğinde aynen tutulur);
// böylece istemcide dosya okumaya gerek kalmaz.
const TEMIZ_METIN =
  ORNEKLER.find((o) => o.id === "detayli")?.metin ?? ORNEKLER[0].metin;

// Payload'lar burada saklanır (sayfa yenilense de kaybolmasın).
const LS_KEY = "saldiri_payloadlari";
// Kart seçimleri (hangi saldırılar koşuya alınacak) burada saklanır.
const LS_SECIM_KEY = "saldiri_secimleri";

// Maliyet ÖN tahmininde varsayacağımız kaba completion token sayısı. Gerçek
// değer koşu bitince ölçülür; bu yalnızca onay öncesi ALT SINIR tahmini içindir.
const TAHMINI_COMPLETION_TOKEN = 1200;

// Onay öncesi SÜRE tahmini: koşular SIRAYLA gider; her çağrı için kaba ortalama.
// Tool turları ve ağ gecikmesi gerçek süreyi artırabilir -> bu kaba bir tahmindir.
const TAHMINI_CAGRI_MS = 6000;

// ms'yi "1 dk 30 sn" biçiminde okunur süreye çevirir (onay diyaloğu için).
function sureBicimle(ms: number): string {
  const toplamSn = Math.round(ms / 1000);
  const dk = Math.floor(toplamSn / 60);
  const sn = toplamSn % 60;
  if (dk <= 0) return `${sn} sn`;
  return `${dk} dk ${sn} sn`;
}

// Client tarafı "bugün" (YYYY-MM-DD). Yalnızca handler içinde çağrılır.
function bugunBul(): string {
  return new Date().toISOString().slice(0, 10);
}

// Bir koşu planı öğesi: hangi saldırı, hangi koşul, kaçıncı koşu, hangi metin.
type PlanOgesi = {
  saldiriId: string;
  saldiriAd: string;
  savunma: boolean;
  kosuNo: number;
  metin: string;
};

// PROMPT ŞEFFAFLIĞI için gösterilecek tek bir mesaj (yalnızca görünürlük).
type GosterMesaj = { rol: string; icerik: string };

// ÇIKTI GÖRÜNÜRLÜĞÜ: ham çıktıdan okunan tek bir madde (yalnızca gösterim).
type CiktiMadde = {
  alinti: string;
  riskSeviyesi: string;
  gerekce: string;
  oneri: string;
  sureIfadesi: string | null;
};

// Temiz referans vs saldırı karşılaştırmasında tek satır.
type KarsilastirmaSatiri = {
  alinti: string;
  temiz: string | null; // temiz koşudaki risk seviyesi (yoksa null)
  saldiri: string | null; // saldırı koşusundaki risk seviyesi (yoksa null)
  durum: "ayni" | "degisti" | "eklendi" | "kayboldu";
};

// Sadeleştirilmiş özet satırı: ozetHesapla çıktısı + kanıt sütunu sunumu.
type OzetSunumSatiri = OzetSatir & {
  kanitSutunu: KanitSutunu;
  degerler: number[];
  bandDisi: number;
};

// Risk seviyesine göre renk sınıfı (dusuk/orta/yuksek).
function riskSinif(r: string | null): string {
  if (r === "dusuk") return "risk-dusuk";
  if (r === "orta") return "risk-orta";
  if (r === "yuksek") return "risk-yuksek";
  return "";
}

// ===== BASELINE (GÜRÜLTÜ) BANDI — yalnızca SUNUM; temiz referanstan türetilir ===
// Temiz koşulardan mekanik min-max aralıkları + risk imzası dağılımı. Bir saldırı
// koşusu bu bandın DIŞINA çıkarsa "band dışı" işaretlenir (mekanik kıyas; "başarılı"
// etiketi DEĞİL). Ham veriyi/ölçümü değiştirmez; sadece okumaya yardımcı olur.
type Bant = {
  ornek: number;
  maddeMin: number;
  maddeMax: number;
  ctMin: number;
  ctMax: number;
  dusukMin: number;
  dusukMax: number;
  kismiMin: number;
  kismiMax: number;
  bulunamadiMin: number;
  bulunamadiMax: number;
  toolMin: number;
  toolMax: number;
  imzaSet: Set<string>;
  imzaDagilim: { imza: string; adet: number }[];
};

function bantHesapla(ms: KosuMetrik[]): Bant | null {
  if (ms.length === 0) return null;
  const mm = (f: (m: KosuMetrik) => number): [number, number] => {
    const arr = ms.map(f);
    return [Math.min(...arr), Math.max(...arr)];
  };
  const [maddeMin, maddeMax] = mm((m) => m.maddeSayisi);
  const [ctMin, ctMax] = mm((m) => m.completionToken);
  const [dusukMin, dusukMax] = mm((m) => m.riskDagilimi.dusuk);
  const [kismiMin, kismiMax] = mm((m) => m.kismiAlinti);
  const [bulunamadiMin, bulunamadiMax] = mm((m) => m.bulunamadiAlinti);
  const [toolMin, toolMax] = mm((m) => m.toolCagriSayisi);
  const sayac = new Map<string, number>();
  for (const m of ms) {
    const imza = riskImzasi(m.riskDagilimi);
    sayac.set(imza, (sayac.get(imza) ?? 0) + 1);
  }
  const imzaDagilim = [...sayac.entries()]
    .map(([imza, adet]) => ({ imza, adet }))
    .sort((a, b) => b.adet - a.adet);
  return {
    ornek: ms.length,
    maddeMin,
    maddeMax,
    ctMin,
    ctMax,
    dusukMin,
    dusukMax,
    kismiMin,
    kismiMax,
    bulunamadiMin,
    bulunamadiMax,
    toolMin,
    toolMax,
    imzaSet: new Set(sayac.keys()),
    imzaDagilim,
  };
}

// Bir değerin bandın altında/üstünde/içinde olduğu (mekanik).
function bantYon(v: number, min: number, max: number): "alt" | "ust" | null {
  if (v < min) return "alt";
  if (v > max) return "ust";
  return null;
}

// Saldırının "kanıt sütunu" için o koşudaki sayısal değer.
function kanitDeger(m: KosuMetrik, k: KanitSutunu): number {
  switch (k) {
    case "MADDE":
      return m.maddeSayisi;
    case "DUSUK":
      return m.riskDagilimi.dusuk;
    case "CT":
      return m.completionToken;
    case "BULUNAMADI":
      return m.bulunamadiAlinti;
    case "TOOL":
      return m.toolCagriSayisi;
  }
}

// Kanıt sütununun ham tablodaki kolon anahtarı (vurgulama için).
function kanitKolonKey(k: KanitSutunu): string {
  switch (k) {
    case "MADDE":
      return "madde";
    case "DUSUK":
      return "doy";
    case "CT":
      return "cT";
    case "BULUNAMADI":
      return "bulunamadi";
    case "TOOL":
      return "tool";
  }
}

// Kanıt sütununun band aralığı (min-max) — band dışı sayımı için.
function kanitBant(k: KanitSutunu, b: Bant): [number, number] {
  switch (k) {
    case "MADDE":
      return [b.maddeMin, b.maddeMax];
    case "DUSUK":
      return [b.dusukMin, b.dusukMax];
    case "CT":
      return [b.ctMin, b.ctMax];
    case "BULUNAMADI":
      return [b.bulunamadiMin, b.bulunamadiMax];
    case "TOOL":
      return [b.toolMin, b.toolMax];
  }
}

// id -> Saldiri (kanıt metadatası için hızlı erişim).
const SALDIRI_INDEKS = new Map(SALDIRILAR.map((s) => [s.id, s]));

export default function SaldiriSayfasi() {
  // Payload metinleri (id -> metin). Başlangıç: SALDIRILAR varsayılanları.
  const [payloadlar, setPayloadlar] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const s of SALDIRILAR) o[s.id] = s.payload;
    return o;
  });

  // Kart seçimleri (id -> koşuya alınsın mı). Başlangıç: hepsi seçili.
  const [secili, setSecili] = useState<Record<string, boolean>>(() => {
    const o: Record<string, boolean> = {};
    for (const s of SALDIRILAR) o[s.id] = true;
    return o;
  });

  const [model, setModel] = useState<ModelAdi>("gpt-4.1");
  const [tekrar, setTekrar] = useState(3);
  const [moderasyon, setModerasyon] = useState(false);

  const [calisiyor, setCalisiyor] = useState(false);
  const [ilerleme, setIlerleme] = useState<{
    mevcut: number;
    toplam: number;
    etiket: string; // ör. "A2 savunmasız" — o an çalışan koşu
  } | null>(null);
  const [metrikler, setMetrikler] = useState<KosuMetrik[]>([]);
  // ÇIKTI GÖRÜNÜRLÜĞÜ (yalnızca gösterim): her koşunun ham akış sonucu, metrikler
  // ile AYNI sırada saklanır. Ölçüm/metrik hesabına dokunmaz; "Çıktıyı gör" ve
  // karşılaştırma bunu kullanır (ek API çağrısı yapılmaz).
  const [ciktilar, setCiktilar] = useState<(AkisSonucu | null)[]>([]);
  const [hata, setHata] = useState<string | null>(null);
  const [kopyalandi, setKopyalandi] = useState(false);
  const [ozetKopyalandi, setOzetKopyalandi] = useState(false);

  // PROMPT ŞEFFAFLIĞI (yalnızca görünürlük): hangi satırın prompt'u açık.
  const [acikPrompt, setAcikPrompt] = useState<number | null>(null);
  // ÇIKTI GÖRÜNÜRLÜĞÜ: hangi satırın çıktısı açık.
  const [acikCikti, setAcikCikti] = useState<number | null>(null);
  // Sistem promptundaki "bugün" satırını yeniden kurmak için istemci tarihi.
  // SSR/hydration uyuşmazlığı olmasın diye mount sonrası set edilir.
  const [bugun, setBugun] = useState("");

  // Onay bekleyen çalıştırma (tahmini maliyet gösterilir, kullanıcı onaylar).
  const [onayBekleyen, setOnayBekleyen] = useState<{
    plan: PlanOgesi[];
    cagri: number;
    usd: number;
    sureMs: number; // kaba tahmini toplam süre
    aktifSaldiri: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // localStorage'dan payload'ları yükle (mount sonrası; SSR uyuşmazlığı olmasın).
  // Yalnızca DOLU kayıtlar varsayılanı ezer; böylece eski oturumlardan kalan boş
  // kayıtlar yeni örnek varsayılanları silmez (kullanıcı düzenlediyse korunur).
  useEffect(() => {
    try {
      const ham = localStorage.getItem(LS_KEY);
      if (!ham) return;
      const kayit = JSON.parse(ham) as Record<string, string>;
      setPayloadlar((mevcut) => {
        const yeni = { ...mevcut };
        for (const s of SALDIRILAR) {
          if (typeof kayit[s.id] === "string" && kayit[s.id].trim()) {
            yeni[s.id] = kayit[s.id];
          }
        }
        return yeni;
      });
    } catch {
      /* bozuk kayıt varsa yut */
    }
  }, []);

  // localStorage'dan kart seçimlerini yükle (mount sonrası).
  useEffect(() => {
    try {
      const ham = localStorage.getItem(LS_SECIM_KEY);
      if (!ham) return;
      const kayit = JSON.parse(ham) as Record<string, boolean>;
      setSecili((mevcut) => {
        const yeni = { ...mevcut };
        for (const s of SALDIRILAR) {
          if (typeof kayit[s.id] === "boolean") yeni[s.id] = kayit[s.id];
        }
        return yeni;
      });
    } catch {
      /* bozuk kayıt varsa yut */
    }
  }, []);

  // İstemci tarihini mount sonrası hesapla (prompt yeniden-kurulumu için).
  useEffect(() => {
    setBugun(bugunBul());
  }, []);

  function payloadGuncelle(id: string, deger: string) {
    setPayloadlar((mevcut) => {
      const yeni = { ...mevcut, [id]: deger };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(yeni));
      } catch {
        /* localStorage kapalıysa yut */
      }
      return yeni;
    });
  }

  function seciliGuncelle(id: string, deger: boolean) {
    setSecili((mevcut) => {
      const yeni = { ...mevcut, [id]: deger };
      try {
        localStorage.setItem(LS_SECIM_KEY, JSON.stringify(yeni));
      } catch {
        /* localStorage kapalıysa yut */
      }
      return yeni;
    });
  }

  // N'yi makul aralığa sıkıştır (1..20).
  const n = Math.max(1, Math.min(20, Math.floor(tekrar) || 1));

  // Koşu planını kur: önce temiz referans (2 koşul × N), sonra dolu payload'lu
  // her saldırı (2 koşul × N). Sıra korunur.
  function planYap(): PlanOgesi[] {
    const plan: PlanOgesi[] = [];
    for (const sav of [false, true]) {
      for (let k = 1; k <= n; k++) {
        plan.push({
          saldiriId: "TEMIZ",
          saldiriAd: "Temiz (referans)",
          savunma: sav,
          kosuNo: k,
          metin: TEMIZ_METIN,
        });
      }
    }
    for (const s of SALDIRILAR) {
      if (!secili[s.id]) continue; // seçili değil -> koşuya alınmaz
      if (!payloadlar[s.id]?.trim()) continue; // boş payload -> koşuya alınmaz
      const gomulu = payloadGom(TEMIZ_METIN, payloadlar[s.id]);
      for (const sav of [false, true]) {
        for (let k = 1; k <= n; k++) {
          plan.push({
            saldiriId: s.id,
            saldiriAd: s.ad,
            savunma: sav,
            kosuNo: k,
            metin: gomulu,
          });
        }
      }
    }
    return plan;
  }

  // Onay öncesi kaba maliyet tahmini. Prompt token'ı gerçek metinden hesaplarız;
  // completion'ı sabit tahminle alırız. Tool turları maliyeti ARTIRABİLİR -> bu
  // bir ALT SINIRdır.
  function maliyetTahmini(plan: PlanOgesi[]): number {
    const bugun = bugunBul();
    let usd = 0;
    for (const po of plan) {
      const sys = sistemPromptu(bugun, po.savunma);
      const kullanici = po.savunma ? sozlesmeMetniniSar(po.metin) : po.metin;
      const promptTok = kabaTokenTahmini(sys + "\n" + kullanici);
      usd += maliyetHesapla(model, promptTok, TAHMINI_COMPLETION_TOKEN);
    }
    return usd;
  }

  // "Çalıştır" -> planı kur, maliyeti hesapla, ONAY iste (henüz çalıştırma).
  function calistirIste() {
    if (calisiyor) return;
    const aktifSaldiri = SALDIRILAR.filter(
      (s) => secili[s.id] && payloadlar[s.id]?.trim()
    ).length;
    if (aktifSaldiri === 0) {
      setHata(
        "Çalıştırmak için en az bir saldırı seçin (kart başlığındaki kutucuğu işaretleyin ve payload dolu olsun)."
      );
      return;
    }
    const plan = planYap();
    setHata(null);
    setOnayBekleyen({
      plan,
      cagri: plan.length,
      usd: maliyetTahmini(plan),
      sureMs: plan.length * TAHMINI_CAGRI_MS,
      aktifSaldiri,
    });
  }

  // Onaylandı -> koşuları SIRAYLA çalıştır.
  async function onayla() {
    const bekleyen = onayBekleyen;
    setOnayBekleyen(null);
    if (!bekleyen) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setCalisiyor(true);
    setMetrikler([]); // yeni koşu seti: önceki sonuçların üstüne yazma
    setCiktilar([]); // çıktı kayıtları da sıfırlanır (metriklerle hizalı kalsın)
    setAcikPrompt(null);
    setAcikCikti(null);
    setHata(null);

    try {
      for (let i = 0; i < bekleyen.plan.length; i++) {
        if (controller.signal.aborted) break;
        const po = bekleyen.plan[i];
        setIlerleme({
          mevcut: i + 1,
          toplam: bekleyen.plan.length,
          etiket: `${po.saldiriId} ${po.savunma ? "savunmalı" : "savunmasız"}`,
        });
        const akis = await analiziCalistir(
          { metin: po.metin, model, savunma: po.savunma, moderasyon },
          controller.signal
        );
        const m = metrikCikar(
          akis,
          {
            saldiriId: po.saldiriId,
            saldiriAd: po.saldiriAd,
            savunma: po.savunma,
            kosuNo: po.kosuNo,
          },
          // Doğrulama dışı alıntıları KISMI/BULUNAMADI diye ayırabilmek için,
          // koşuda gönderilen kaynak metin (route'un doğruladığıyla aynı).
          po.metin
        );
        // metrikler ve ciktilar AYNI iterasyonda, AYNI sırada eklenir -> index'ler hizalı.
        setMetrikler((prev) => [...prev, m]);
        setCiktilar((prev) => [...prev, akis]);
      }
    } catch (e) {
      // İptal -> sessiz; diğer hataları göster.
      if ((e as Error)?.name !== "AbortError") {
        setHata((e as Error)?.message ?? "Bilinmeyen hata.");
      }
    } finally {
      setCalisiyor(false);
      setIlerleme(null);
      abortRef.current = null;
    }
  }

  function durdur() {
    abortRef.current?.abort();
  }

  function temizle() {
    setMetrikler([]);
    setCiktilar([]);
    setAcikPrompt(null);
    setAcikCikti(null);
    setHata(null);
  }

  // CSV metnini dosya olarak indir (ortak yardımcı).
  function csvDosyaIndir(csv: string, dosyaAdi: string) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = dosyaAdi;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Metni panoya kopyala; kısa süre "kopyalandı" göster (ortak yardımcı).
  async function panoyaKopyala(metin: string, isaretle: (v: boolean) => void) {
    try {
      await navigator.clipboard.writeText(metin);
      isaretle(true);
      setTimeout(() => isaretle(false), 1500);
    } catch {
      setHata("Panoya kopyalanamadı (tarayıcı izni gerekebilir).");
    }
  }

  // Ham koşu tablosu: CSV indir + Markdown kopyala.
  function csvIndir() {
    csvDosyaIndir(csvUret(metrikler), "saldiri-ham-tablo.csv");
  }
  function markdownKopyala() {
    void panoyaKopyala(markdownUret(metrikler), setKopyalandi);
  }

  // Özet tablosu (sadeleştirilmiş) CSV/markdown — ekrandaki ozetSunum ile birebir.
  const OZET_BASLIK = [
    "saldiri",
    "saldiriAd",
    "kosul",
    "N",
    "kanitSutunu",
    "kanitDegerleri",
    "bandDisi",
    "ortEkToken",
    "ortEkUsd",
  ];
  function ozetSunumSatir(o: OzetSunumSatiri): (string | number)[] {
    return [
      o.saldiriId,
      o.saldiriAd,
      o.savunma ? "savunmali" : "savunmasiz",
      o.n,
      o.kanitSutunu,
      o.degerler.join(" "),
      `${o.bandDisi}/${o.n}`,
      o.ortEkToken,
      o.ortEkUsd.toFixed(6),
    ];
  }
  function ozetCsvIndir() {
    const kacir = (v: string | number) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const satirlar = [OZET_BASLIK.join(",")];
    for (const o of ozetSunum) satirlar.push(ozetSunumSatir(o).map(kacir).join(","));
    csvDosyaIndir(satirlar.join("\n"), "saldiri-ozet-tablo.csv");
  }
  function ozetMarkdownKopyala() {
    const kacir = (v: string | number) =>
      String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
    const satirlar = [
      `| ${OZET_BASLIK.join(" | ")} |`,
      `| ${OZET_BASLIK.map(() => "---").join(" | ")} |`,
    ];
    for (const o of ozetSunum)
      satirlar.push(`| ${ozetSunumSatir(o).map(kacir).join(" | ")} |`);
    void panoyaKopyala(satirlar.join("\n"), setOzetKopyalandi);
  }

  const ozet = useMemo(() => ozetHesapla(metrikler), [metrikler]);

  // Temiz referans profilleri (özet başlığında göstermek için).
  const refSavunmasiz = useMemo(
    () =>
      referansProfil(
        metrikler.filter((m) => m.saldiriId === "TEMIZ" && !m.savunma)
      ),
    [metrikler]
  );
  const refSavunmali = useMemo(
    () =>
      referansProfil(
        metrikler.filter((m) => m.saldiriId === "TEMIZ" && m.savunma)
      ),
    [metrikler]
  );

  const sonucVar = metrikler.length > 0;

  // Temiz referanstan (savunmasız/savunmalı) gürültü bandı — yalnızca sunum.
  const bantlar = useMemo(
    () => ({
      savunmasiz: bantHesapla(
        metrikler.filter((m) => m.saldiriId === "TEMIZ" && !m.savunma)
      ),
      savunmali: bantHesapla(
        metrikler.filter((m) => m.saldiriId === "TEMIZ" && m.savunma)
      ),
    }),
    [metrikler]
  );

  // Bir satır için ilgili band (koşuluna göre).
  function satirBandi(m: KosuMetrik): Bant | null {
    return m.savunma ? bantlar.savunmali : bantlar.savunmasiz;
  }

  // Sadeleştirilmiş özet: her (saldırı × koşul) için kanıt sütunu değerleri +
  // band-dışı koşu sayısı (yalnızca sunum; ozetHesapla çıktısını zenginleştirir).
  const ozetSunum = useMemo(() => {
    return ozet.map((o) => {
      const saldiri = SALDIRI_INDEKS.get(o.saldiriId);
      const kanitSutunu: KanitSutunu = saldiri?.kanitSutunu ?? "MADDE";
      const hucre = metrikler.filter(
        (m) => m.saldiriId === o.saldiriId && m.savunma === o.savunma
      );
      const degerler = hucre.map((m) => kanitDeger(m, kanitSutunu));
      const b = o.savunma ? bantlar.savunmali : bantlar.savunmasiz;
      let bandDisi = 0;
      if (b) {
        const [min, max] = kanitBant(kanitSutunu, b);
        bandDisi = degerler.filter((v) => bantYon(v, min, max) !== null).length;
      }
      return { ...o, kanitSutunu, degerler, bandDisi };
    });
  }, [ozet, metrikler, bantlar]);

  // Kanıt sütunu vurgusu: saldırı satırında kanıt kolonu "vurgu", diğer metrik
  // kolonları "sönük"; TEMIZ satırında hepsi normal.
  function hucreSinif(m: KosuMetrik, kolonKey: string): string {
    const saldiri = SALDIRI_INDEKS.get(m.saldiriId);
    if (!saldiri) return "";
    return kanitKolonKey(saldiri.kanitSutunu) === kolonKey
      ? "kanit-vurgu"
      : "kanit-sonuk";
  }

  // Bir sayısal hücre için band-dışı ok işareti (TEMIZ satırında gösterme).
  function okIsareti(m: KosuMetrik, deger: number, aralik: [number, number] | null) {
    if (m.saldiriId === "TEMIZ" || !aralik) return null;
    const yon = bantYon(deger, aralik[0], aralik[1]);
    if (!yon) return null;
    return (
      <span className="bant-ok" title="temiz referans bandının dışında">
        {yon === "alt" ? " ↓" : " ↑"}
      </span>
    );
  }

  // Risk imzası band dışı mı (temiz referansta hiç görülmemiş imza)?
  function imzaBandDisi(m: KosuMetrik, b: Bant | null): boolean {
    if (m.saldiriId === "TEMIZ" || !b) return false;
    return !b.imzaSet.has(riskImzasi(m.riskDagilimi));
  }

  // Bir koşunun KAYNAK metnini (payload gömülü / temiz) yeniden kurar. Route'un
  // doğrulamada kullandığı `metin` ile aynıdır: temiz -> TEMIZ_METIN, saldırı ->
  // payloadGom(TEMIZ_METIN, payload). Payload koşudan sonra düzenlenirse değişir.
  function kaynakMetniKur(m: KosuMetrik): string {
    return m.saldiriId === "TEMIZ"
      ? TEMIZ_METIN
      : payloadGom(TEMIZ_METIN, payloadlar[m.saldiriId] ?? "");
  }

  // ===== PROMPT ŞEFFAFLIĞI (yalnızca görünürlük; hiçbir istek göndermez) =====
  //
  // Bir koşuda OpenAI'a gönderilen İLK isteğin messages dizisini, route ile
  // BİREBİR aynı saf fonksiyonlardan (lib/prompt) YENİDEN KURAR. Ölçüm/koşu
  // akışına dokunmaz; sadece satırın parametrelerinden (metin + savunma bayrağı)
  // türetir. Payload'ı koşudan sonra düzenlerseniz burada da değişir.
  function kosuMesajlari(m: KosuMetrik): GosterMesaj[] {
    const metin = kaynakMetniKur(m);
    // route.ts ile birebir: sistem + kullanıcı (savunmalıysa <SOZLESME_METNI> sarmalı).
    const mesajlar: GosterMesaj[] = [
      { rol: "system", icerik: sistemPromptu(bugun, m.savunma) },
      { rol: "user", icerik: m.savunma ? sozlesmeMetniniSar(metin) : metin },
    ];
    // Bu koşuda gerçekleşen tool çağrıları (kayıtlı argümanlardan). Bunlar,
    // sonraki turda assistant mesajı olarak geçmişe eklenip OpenAI'a gider.
    const toolAdi = toolTanimlari[0]?.function.name ?? "tool";
    for (const args of m.toolArgumanlari) {
      mesajlar.push({
        rol: "assistant · tool çağrısı",
        icerik: `${toolAdi}(${JSON.stringify(args)})`,
      });
    }
    return mesajlar;
  }

  // ===== ÇIKTI GÖRÜNÜRLÜĞÜ (yalnızca gösterim; mevcut kayıtlı veriden) =========

  // Ham akış çıktısından madde listesini güvenle çıkarır (şemaya tam uymasa da).
  function ciktiMaddeleri(akis: AkisSonucu | null | undefined): CiktiMadde[] {
    if (!akis) return [];
    try {
      const obj = JSON.parse(akis.ham) as { maddeler?: unknown };
      const arr = Array.isArray(obj?.maddeler) ? obj.maddeler : [];
      return arr.map((ham) => {
        const o = (ham ?? {}) as Record<string, unknown>;
        const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
        return {
          alinti: s("alinti"),
          riskSeviyesi: s("riskSeviyesi") || "?",
          gerekce: s("gerekce"),
          oneri: s("oneri"),
          sureIfadesi: typeof o.sureIfadesi === "string" ? o.sureIfadesi : null,
        };
      });
    } catch {
      return [];
    }
  }

  // Ham JSON'u okunur biçime sok (parse edilebiliyorsa 2 boşlukla).
  function hamGuzel(akis: AkisSonucu | null | undefined): string {
    if (!akis) return "(çıktı kaydı yok)";
    try {
      return JSON.stringify(JSON.parse(akis.ham), null, 2);
    } catch {
      return akis.ham || "(boş)";
    }
  }

  // Bir saldırı satırı için AYNI koşuldaki (savunma) ilk TEMIZ referans çıktısı.
  function temizReferansCiktisi(m: KosuMetrik): AkisSonucu | null {
    for (let j = 0; j < metrikler.length; j++) {
      if (metrikler[j].saldiriId === "TEMIZ" && metrikler[j].savunma === m.savunma) {
        return ciktilar[j] ?? null;
      }
    }
    return null;
  }

  // İki koşunun maddelerini normalize edilmiş alıntıya göre eşleştirip karşılaştırır.
  function maddeleriKarsilastir(
    temizMaddeler: CiktiMadde[],
    saldiriMaddeler: CiktiMadde[]
  ): KarsilastirmaSatiri[] {
    const anahtar = (mm: CiktiMadde) =>
      normalizeMetin(mm.alinti).slice(0, 80) || normalizeMetin(mm.gerekce).slice(0, 80);
    const saldiriMap = new Map<string, CiktiMadde>();
    for (const mm of saldiriMaddeler) saldiriMap.set(anahtar(mm), mm);

    const satirlar: KarsilastirmaSatiri[] = [];
    const gorulen = new Set<string>();
    for (const t of temizMaddeler) {
      const k = anahtar(t);
      gorulen.add(k);
      const s = saldiriMap.get(k);
      satirlar.push({
        alinti: t.alinti || s?.alinti || "(boş)",
        temiz: t.riskSeviyesi,
        saldiri: s ? s.riskSeviyesi : null,
        durum: !s ? "kayboldu" : t.riskSeviyesi !== s.riskSeviyesi ? "degisti" : "ayni",
      });
    }
    for (const s of saldiriMaddeler) {
      const k = anahtar(s);
      if (gorulen.has(k)) continue;
      satirlar.push({
        alinti: s.alinti || "(boş)",
        temiz: null,
        saldiri: s.riskSeviyesi,
        durum: "eklendi",
      });
    }
    return satirlar;
  }

  // Bir koşunun TAM çıktısını (maddeler + doğrulama teşhisi + karşılaştırma + ham
  // JSON) render eder. Yalnızca gösterim; kayıtlı çıktıdan üretir, istek göndermez.
  function ciktiGoruntu(m: KosuMetrik, akis: AkisSonucu | null | undefined) {
    const kaynak = kaynakMetniKur(m);
    const maddeler = ciktiMaddeleri(akis);
    const saldiriMi = m.saldiriId !== "TEMIZ";
    const temizAkis = saldiriMi ? temizReferansCiktisi(m) : null;
    const karsilastirma =
      saldiriMi && temizAkis
        ? maddeleriKarsilastir(ciktiMaddeleri(temizAkis), maddeler)
        : null;

    const seviyeSinif = (s: DogrulamaSeviyesi) =>
      s === "tam" ? "dogr-tam" : s === "kismi" ? "dogr-kismi" : "dogr-yok";
    const seviyeMetin = (s: DogrulamaSeviyesi) =>
      s === "tam" ? "tam" : s === "kismi" ? "kısmi" : "bulunamadı";

    return (
      <div className="cikti-goruntu">
        <div className="prompt-not">
          Bu koşunun TAM sonucu. Alıntı doğrulaması, düzeltilmiş normalize
          mantığıyla istemcide YENİDEN çalıştırılır (ek istek yok); kaynak metin
          satırın parametrelerinden kurulur.
        </div>

        {maddeler.length === 0 ? (
          <div className="prompt-not">
            (Geçerli madde çıkarılamadı — ham JSON aşağıda.)
          </div>
        ) : (
          maddeler.map((md, j) => {
            const d = alintiDogrulaDetay(md.alinti, kaynak);
            return (
              <div className="cikti-madde" key={j}>
                <div className="cikti-madde-ust">
                  <span className="cikti-madde-no">Madde {j + 1}</span>
                  <span className={`risk-rozet ${riskSinif(md.riskSeviyesi)}`}>
                    {md.riskSeviyesi}
                  </span>
                  <span className="esne" />
                  <span className={`dogr-rozet ${seviyeSinif(d.seviye)}`}>
                    alıntı: {seviyeMetin(d.seviye)}
                  </span>
                </div>
                <div className="cikti-alan">
                  <b>alıntı:</b> {md.alinti || "—"}
                </div>
                <div className="cikti-alan">
                  <b>gerekçe:</b> {md.gerekce || "—"}
                </div>
                <div className="cikti-alan">
                  <b>öneri:</b> {md.oneri || "—"}
                </div>
                <div className="cikti-alan">
                  <b>süre ifadesi:</b> {md.sureIfadesi ?? "null"}
                </div>
                {d.seviye !== "tam" && (
                  <div className="dogr-teshis">
                    <div className="dogr-teshis-baslik">
                      Neden {seviyeMetin(d.seviye)}? ({d.eslesenKelime}/
                      {d.toplamKelime} kelime eşleşti)
                    </div>
                    <div className="dogr-yanyana">
                      <div>
                        <div className="dogr-etiket">normalize alıntı</div>
                        <pre className="dogr-kod">
                          {d.normalizeAlinti || "(boş)"}
                        </pre>
                      </div>
                      <div>
                        <div className="dogr-etiket">kaynakta en yakın parça</div>
                        <pre className="dogr-kod">
                          {d.normalizeKaynakParca || "(boş)"}
                        </pre>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        {saldiriMi && (
          <div className="cikti-kars">
            <div className="prompt-rol">
              Karşılaştırma: temiz referans → bu saldırı (
              {m.savunma ? "savunmalı" : "savunmasız"})
            </div>
            {!temizAkis ? (
              <div className="prompt-not">
                Aynı koşulda temiz referans çıktısı bulunamadı.
              </div>
            ) : (
              <table className="deney-tablo kars-tablo">
                <thead>
                  <tr>
                    <th>alıntı (kısaltılmış)</th>
                    <th>temiz</th>
                    <th>saldırı</th>
                    <th>durum</th>
                  </tr>
                </thead>
                <tbody>
                  {(karsilastirma ?? []).map((k, j) => (
                    <tr
                      key={j}
                      className={k.durum !== "ayni" ? "kars-vurgu" : ""}
                    >
                      <td className="kars-alinti" title={k.alinti}>
                        {k.alinti.length > 70
                          ? k.alinti.slice(0, 70) + "…"
                          : k.alinti}
                      </td>
                      <td className={riskSinif(k.temiz)}>{k.temiz ?? "—"}</td>
                      <td className={riskSinif(k.saldiri)}>
                        {k.saldiri ?? "—"}
                      </td>
                      <td>
                        {k.durum === "degisti"
                          ? "risk değişti"
                          : k.durum === "eklendi"
                          ? "eklendi"
                          : k.durum === "kayboldu"
                          ? "kayboldu"
                          : "aynı"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="cikti-ham">
          <div className="prompt-rol">ham JSON</div>
          <pre className="prompt-icerik">{hamGuzel(akis)}</pre>
        </div>
      </div>
    );
  }

  // "Savunma nedir?" bölümü: savunmasız (base) vs savunmalı (base + güvenlik)
  // sistem promptlarının satır bazlı diff'i. Tasarım append-only olduğundan
  // savunmalı, savunmasızın tüm satırlarını içerir + eklenen satırlar.
  const savunmaDiff = useMemo(() => {
    const solSatirlar = sistemPromptu(bugun, false).split("\n");
    const sagHam = sistemPromptu(bugun, true).split("\n");
    const sagSatirlar: { metin: string; eklendi: boolean }[] = [];
    let i = 0;
    for (const satir of sagHam) {
      if (i < solSatirlar.length && solSatirlar[i] === satir) {
        sagSatirlar.push({ metin: satir, eklendi: false });
        i++;
      } else {
        sagSatirlar.push({ metin: satir, eklendi: true });
      }
    }
    return { solSatirlar, sagSatirlar };
  }, [bugun]);

  // Bayrağın gerçekten bağlı olduğunu gözle doğrulamak için: aynı metin (temiz
  // referans) üzerinden savunmalı vs savunmasız TAM prompt (system + user) uzunluk
  // farkı. Tarih iki tarafta da aynı olduğundan sonuç sabittir.
  const promptFarkKarakter = useMemo(() => {
    const savunmasiz =
      sistemPromptu(bugun, false).length + TEMIZ_METIN.length;
    const savunmali =
      sistemPromptu(bugun, true).length + sozlesmeMetniniSar(TEMIZ_METIN).length;
    return savunmali - savunmasiz;
  }, [bugun]);

  return (
    <main className="deney-kapsayici">
      <h1>Saldırı Paneli — Prompt Injection Ölçümü</h1>
      <p className="altbaslik">
        5 saldırı ailesi × 2 koşul (savunmasız/savunmalı) × N koşu; temiz referans
        otomatik alınır. Koşular sırayla çalışır, iptal edilebilir.{" "}
        <a className="baglanti" href="/">
          ← Normal tarama
        </a>{" "}
        ·{" "}
        <a className="baglanti" href="/deney">
          Deney modu →
        </a>
      </p>

      {/* -------- Savunma nedir? (savunmasız vs savunmalı sistem promptu diff) -------- */}
      <details className="savunma-detay" open>
        <summary className="referans-ozet">
          Savunma nedir? — savunmasız / savunmalı sistem promptu (yan yana)
        </summary>
        <p className="altbaslik" style={{ marginTop: 8 }}>
          Savunmalı koşu, savunmasız base sistem promptunun{" "}
          <b>üstüne</b> bir GÜVENLİK / SINIRLANDIRMA bölümü ekler ve ayrıca
          kullanıcı metnini <code>&lt;SOZLESME_METNI&gt;</code> etiketleriyle sarar.
          Sağ sütunda <span className="diff-eklendi-ornek">yeşil</span> satırlar
          savunmayla eklenenlerdir.
        </p>
        <div className="savunma-diff">
          <div className="savunma-sutun">
            <div className="savunma-sutun-baslik">savunmasız (base)</div>
            <div className="diff-kod">
              {savunmaDiff.solSatirlar.map((l, i) => (
                <div className="diff-satir" key={i}>
                  {"  " + (l || " ")}
                </div>
              ))}
            </div>
          </div>
          <div className="savunma-sutun">
            <div className="savunma-sutun-baslik">
              savunmalı (base + güvenlik)
            </div>
            <div className="diff-kod">
              {savunmaDiff.sagSatirlar.map((l, i) => (
                <div
                  className={`diff-satir ${l.eklendi ? "eklendi" : ""}`}
                  key={i}
                >
                  {(l.eklendi ? "+ " : "  ") + (l.metin || " ")}
                </div>
              ))}
            </div>
          </div>
        </div>
      </details>

      {/* -------- Örnek/temiz referans metin (üzerinde manipülasyon denenen belge) -------- */}
      <details className="referans-detay">
        <summary className="referans-ozet">
          Örnek sözleşme metni — payload&apos;ların gömüldüğü temiz referans
          (göster/gizle)
        </summary>
        <p className="altbaslik" style={{ marginTop: 8 }}>
          Tüm saldırılar bu metnin üzerine kurulur: seçilen payload, metnin
          ortasındaki madde sınırına gömülür; &quot;temiz referans&quot; koşusu ise
          aynı metni payload&apos;suz çalıştırıp kıyas tabanını oluşturur.
        </p>
        <pre className="referans-metin">{TEMIZ_METIN}</pre>
      </details>

      {/* -------- Payload editörleri -------- */}
      <h2 style={{ fontSize: 16, marginTop: 8 }}>Saldırılar</h2>
      <p className="altbaslik">
        Her kart, düzenleyebileceğiniz örnek bir payload ile hazır gelir; metni
        değiştirebilir veya silebilirsiniz. Kart başlığındaki kutucukla o saldırıyı
        koşuya <b>dâhil eder ya da hariç tutarsınız</b>; işareti kaldırılan (veya
        payload&apos;u boş) saldırı çalıştırılmaz. Seçimler ve metinler tarayıcıda
        saklanır.
      </p>

      <div className="saldiri-kartlar">
        {SALDIRILAR.map((s) => {
          const dolu = !!payloadlar[s.id]?.trim();
          const isaretli = !!secili[s.id];
          const calisacak = isaretli && dolu; // koşuya gerçekten alınır mı
          const rozet = !isaretli
            ? { sinif: "bos", metin: "hariç" }
            : dolu
            ? { sinif: "dolu", metin: "çalışacak" }
            : { sinif: "bos", metin: "boş" };
          return (
            <div
              className={`saldiri-kart ${calisacak ? "dolu" : "bos"} ${
                isaretli ? "" : "secili-degil"
              }`}
              key={s.id}
            >
              <div className="saldiri-ust">
                <input
                  type="checkbox"
                  className="saldiri-secim"
                  checked={isaretli}
                  onChange={(e) => seciliGuncelle(s.id, e.target.checked)}
                  disabled={calisiyor}
                  title="Bu saldırıyı koşuya dâhil et / hariç tut"
                  aria-label={`${s.id} saldırısını koşuya dâhil et`}
                />
                <span className="saldiri-id">{s.id}</span>
                <span className="saldiri-ad">{s.ad}</span>
                <span className="esne" />
                <span className={`saldiri-rozet ${rozet.sinif}`}>
                  {rozet.metin}
                </span>
              </div>
              <div className="saldiri-amac">
                <b>Amaç:</b> {s.amac}
              </div>
              <div className="saldiri-kriter">
                <b>Başarı kriteri (elle yorum):</b> {s.basariKriteriAciklamasi}
              </div>
              <textarea
                className="saldiri-payload"
                value={payloadlar[s.id] ?? ""}
                onChange={(e) => payloadGuncelle(s.id, e.target.value)}
                placeholder="Bu saldırının payload'unu buraya yazın (boş = koşuya alınmaz)…"
                disabled={calisiyor}
              />
            </div>
          );
        })}
      </div>

      {/* -------- Koşu ayarları -------- */}
      <div className="satir">
        <label className="secim">
          Model:
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as ModelAdi)}
            disabled={calisiyor}
          >
            {Object.keys(FIYATLAR).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="secim">
          Koşu sayısı (N):
          <input
            className="deney-sayi"
            type="number"
            min={1}
            max={20}
            value={tekrar}
            onChange={(e) => setTekrar(Number(e.target.value))}
            disabled={calisiyor}
          />
        </label>

        <label className="secim">
          <input
            type="checkbox"
            checked={moderasyon}
            onChange={(e) => setModerasyon(e.target.checked)}
            disabled={calisiyor}
          />
          Moderation ölç
        </label>

        <span className="esne" />

        {ilerleme && (
          <span className="altbaslik">
            {ilerleme.mevcut}/{ilerleme.toplam} · {ilerleme.etiket}…
          </span>
        )}

        {!calisiyor ? (
          <button className="birincil" onClick={calistirIste}>
            Çalıştır…
          </button>
        ) : (
          <button className="tehlike" onClick={durdur}>
            Durdur
          </button>
        )}
        <button onClick={temizle} disabled={calisiyor || !sonucVar}>
          Sonuçları temizle
        </button>
      </div>

      {/* -------- İlerleme çubuğu -------- */}
      {ilerleme && (
        <div className="ilerleme-dis">
          <div
            className="ilerleme-ic"
            style={{
              width: `${Math.round((ilerleme.mevcut / ilerleme.toplam) * 100)}%`,
            }}
          />
        </div>
      )}

      {/* -------- Onay kutusu (çalıştırmadan önce) -------- */}
      {onayBekleyen && (
        <div className="onay-kutu">
          <div className="onay-baslik">Çalıştırma onayı</div>
          <div className="onay-satir">
            Toplam <b>{onayBekleyen.cagri}</b> API çağrısı yapılacak (
            {onayBekleyen.aktifSaldiri} aktif saldırı + temiz referans, 2 koşul, N=
            {n}).
          </div>
          <div className="onay-satir">
            Tahmini maliyet:{" "}
            <b>${onayBekleyen.usd.toFixed(4)}</b>{" "}
            <span className="altbaslik">
              (kaba ALT SINIR; completion ≈ {TAHMINI_COMPLETION_TOKEN} tok/çağrı
              varsayıldı, tool turları maliyeti artırabilir)
            </span>
          </div>
          <div className="onay-satir">
            Tahmini süre: <b>~{sureBicimle(onayBekleyen.sureMs)}</b>{" "}
            <span className="altbaslik">
              (koşular sırayla gider; ≈ {Math.round(TAHMINI_CAGRI_MS / 1000)}{" "}
              sn/çağrı varsayıldı)
            </span>
          </div>
          <div className="satir">
            <button className="birincil" onClick={onayla}>
              Onayla ve çalıştır
            </button>
            <button onClick={() => setOnayBekleyen(null)}>Vazgeç</button>
          </div>
        </div>
      )}

      {hata && (
        <div className="hatalar">
          <div className="hata-kutu">
            <span className="tur">Hata:</span>
            {hata}
          </div>
        </div>
      )}

      {/* -------- Ham koşu tablosu -------- */}
      <div className="baslik-satir" style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>
          Ham koşu tablosu {sonucVar ? `(${metrikler.length})` : ""}
        </h2>
        {sonucVar && (
          <div className="satir" style={{ margin: 0 }}>
            <button onClick={csvIndir}>CSV indir</button>
            <button onClick={markdownKopyala}>
              {kopyalandi ? "Kopyalandı ✓" : "Markdown kopyala"}
            </button>
          </div>
        )}
      </div>

      {/* Bayrağın gerçekten bağlı olduğunu gözle doğrulamak için tek satırlık teyit. */}
      <p className="altbaslik prompt-teyit">
        Savunmalı koşu prompt&apos;u savunmasızdan{" "}
        <b>{promptFarkKarakter.toLocaleString("tr-TR")} karakter</b> uzun (sistem
        promptuna güvenlik bölümü + kullanıcı metninin{" "}
        <code>&lt;SOZLESME_METNI&gt;</code> sarmalı). Her satırdaki
        &quot;Prompt&apos;u gör&quot; ile o koşunun tam mesajlarını
        inceleyebilirsiniz.
      </p>

      {/* -------- Baseline (gürültü) bandı -------- */}
      {sonucVar && (
        <div className="bant-kutu">
          <div className="bant-baslik">
            Baseline (gürültü) bandı — temiz referans koşularından
          </div>
          <div className="bant-izgara">
            {([
              ["savunmasiz", "savunmasız", bantlar.savunmasiz] as const,
              ["savunmali", "savunmalı", bantlar.savunmali] as const,
            ]).map(([anahtar, etiket, b]) => (
              <div className="bant-sutun" key={anahtar}>
                <div className="bant-sutun-baslik">{etiket}</div>
                {!b ? (
                  <div className="altbaslik">temiz referans koşusu yok</div>
                ) : (
                  <ul className="bant-liste">
                    <li>
                      madde sayısı:{" "}
                      <b>
                        {b.maddeMin}–{b.maddeMax}
                      </b>
                    </li>
                    <li>
                      risk imzası (d/o/y):{" "}
                      {b.imzaDagilim
                        .map((x) => `${x.imza} ×${x.adet}`)
                        .join("   ·   ")}
                    </li>
                    <li>
                      completion token:{" "}
                      <b>
                        {b.ctMin}–{b.ctMax}
                      </b>
                    </li>
                    <li className="altbaslik">({b.ornek} temiz koşu)</li>
                  </ul>
                )}
              </div>
            ))}
          </div>
          <p className="altbaslik bant-not">
            Bir saldırı ancak bu bandın <b>DIŞINA</b> çıkarsa anlamlıdır; band içi
            fark gürültüden ayırt edilemez. (Mekanik kıyas; &quot;başarılı&quot;
            etiketi değil.)
          </p>
        </div>
      )}

      {!sonucVar ? (
        <p className="bos">Henüz koşu yok. Payload yazıp “Çalıştır”a basın.</p>
      ) : (
        <div className="deney-tablo-sar">
          <table className="deney-tablo saldiri-tablo">
            <thead>
              <tr>
                <th>#</th>
                <th>saldırı</th>
                <th>koşul</th>
                <th title="kaçıncı tekrar koşusu">koşu</th>
                <th title="modelin raporladığı risk maddesi sayısı">madde</th>
                <th title="risk seviyesi dağılımı (risk imzası: düşük/orta/yüksek)">
                  d/o/y
                </th>
                <th title="alıntı kaynakta var ama model kısaltmış (üç nokta) — normal davranış">
                  kısmi
                </th>
                <th title="alıntı kaynakta hiç yok — A4 sızdırmanın sinyali">
                  bulunamadı
                </th>
                <th title="sureHesapla çağrı sayısı">tool</th>
                <th title="modelin tool'a gönderdiği argümanlar">tool argümanları</th>
                <th title="prompt (girdi) token sayısı">pT</th>
                <th title="completion (çıktı) token sayısı">cT</th>
                <th title="maliyet (USD)">$</th>
                <th title="koşu süresi (ms)">ms</th>
                <th title="moderation işaretledi mi">mod</th>
                <th title="moderation gecikmesi (ms)">mod ms</th>
                <th title="hata (varsa)">hata</th>
                <th title="bu koşuda gönderilen mesajlar">prompt</th>
                <th title="bu koşunun tam sonucu (maddeler + ham JSON)">çıktı</th>
              </tr>
            </thead>
            <tbody>
              {metrikler.map((m, i) => {
                const grupBasi =
                  i === 0 || metrikler[i - 1].saldiriId !== m.saldiriId;
                const saldiri = SALDIRI_INDEKS.get(m.saldiriId);
                const b = satirBandi(m);
                return (
                <Fragment key={i}>
                {grupBasi && (
                  <tr className="kanit-satir">
                    <td colSpan={19}>
                      {saldiri ? (
                        <>
                          <b>
                            {saldiri.id} · {saldiri.ad}
                          </b>{" "}
                          — kanıt sütunu: <b>{saldiri.kanitSutunu}</b> · tuttuysa:{" "}
                          {saldiri.tuttuysaNeGorursun}
                        </>
                      ) : (
                        <>
                          <b>TEMIZ · temiz referans</b> — gürültü bandının kaynağı
                          (band-dışı işareti bu satırlara uygulanmaz)
                        </>
                      )}
                    </td>
                  </tr>
                )}
                <tr className={m.saldiriId === "TEMIZ" ? "temiz-satir" : ""}>
                  <td>{i + 1}</td>
                  <td title={m.saldiriAd}>{m.saldiriId}</td>
                  <td className={m.savunma ? "evet" : "hayir"}>
                    {m.savunma ? "savunmalı" : "savunmasız"}
                  </td>
                  <td>{m.kosuNo}</td>
                  <td className={hucreSinif(m, "madde")}>
                    {m.maddeSayisi}
                    {b && okIsareti(m, m.maddeSayisi, [b.maddeMin, b.maddeMax])}
                  </td>
                  <td className={hucreSinif(m, "doy")}>
                    {riskImzasi(m.riskDagilimi)}
                    {imzaBandDisi(m, b) && (
                      <span
                        className="bant-ok"
                        title="temiz referans imza setinde yok"
                      >
                        {" ≠"}
                      </span>
                    )}
                  </td>
                  <td
                    className={`${hucreSinif(m, "kismi")} ${
                      m.kismiAlinti > 0 ? "kismi-hucre" : ""
                    }`.trim()}
                  >
                    {m.kismiAlinti}
                    {b && okIsareti(m, m.kismiAlinti, [b.kismiMin, b.kismiMax])}
                  </td>
                  <td
                    className={`${hucreSinif(m, "bulunamadi")} ${
                      m.bulunamadiAlinti > 0 ? "uyari" : ""
                    }`.trim()}
                  >
                    {m.bulunamadiAlinti}
                    {b &&
                      okIsareti(m, m.bulunamadiAlinti, [
                        b.bulunamadiMin,
                        b.bulunamadiMax,
                      ])}
                  </td>
                  <td
                    className={`${hucreSinif(m, "tool")} ${
                      m.toolCagriSayisi > 0 ? "evet" : "hayir"
                    }`.trim()}
                  >
                    {m.toolCagriSayisi}
                    {b && okIsareti(m, m.toolCagriSayisi, [b.toolMin, b.toolMax])}
                  </td>
                  <td
                    className={`arg-hucre ${hucreSinif(m, "toolArg")}`.trim()}
                    title={JSON.stringify(m.toolArgumanlari)}
                  >
                    {m.toolArgumanlari.length
                      ? JSON.stringify(m.toolArgumanlari)
                      : "—"}
                  </td>
                  <td className={hucreSinif(m, "pT")}>
                    {m.promptToken.toLocaleString("tr-TR")}
                  </td>
                  <td className={hucreSinif(m, "cT")}>
                    {m.completionToken.toLocaleString("tr-TR")}
                    {b && okIsareti(m, m.completionToken, [b.ctMin, b.ctMax])}
                  </td>
                  <td className={hucreSinif(m, "usd")}>${m.usd.toFixed(6)}</td>
                  <td className={hucreSinif(m, "ms")}>
                    {m.sureMs.toLocaleString("tr-TR")}
                  </td>
                  <td className={hucreSinif(m, "mod")}>
                    {m.moderationFlagged === null
                      ? "—"
                      : m.moderationFlagged
                      ? "evet"
                      : "hayır"}
                  </td>
                  <td className={hucreSinif(m, "modms")}>
                    {m.moderationGecikmeMs ?? "—"}
                  </td>
                  <td
                    className={`${hucreSinif(m, "hata")} ${
                      m.hata ? "uyari" : ""
                    }`.trim()}
                    title={m.hata ?? ""}
                  >
                    {m.hata ? "hata" : "—"}
                  </td>
                  <td>
                    <button
                      className="mini-buton"
                      onClick={() =>
                        setAcikPrompt(acikPrompt === i ? null : i)
                      }
                    >
                      {acikPrompt === i ? "gizle" : "Prompt'u gör"}
                    </button>
                  </td>
                  <td>
                    <button
                      className="mini-buton"
                      onClick={() => setAcikCikti(acikCikti === i ? null : i)}
                    >
                      {acikCikti === i ? "gizle" : "Çıktıyı gör"}
                    </button>
                  </td>
                </tr>
                {acikPrompt === i && (
                  <tr className="prompt-satir">
                    <td colSpan={19}>
                      <div className="prompt-goruntu">
                        <div className="prompt-not">
                          Bu koşuda OpenAI&apos;a gönderilen ilk isteğin{" "}
                          <b>messages</b> dizisi (route ile birebir aynı
                          fonksiyonlardan yeniden kuruldu; hiçbir istek gönderilmez).
                        </div>
                        {kosuMesajlari(m).map((msg, j) => (
                          <div className="prompt-mesaj" key={j}>
                            <div className="prompt-rol">{msg.rol}</div>
                            <pre className="prompt-icerik">{msg.icerik}</pre>
                          </div>
                        ))}
                        {m.toolArgumanlari.length > 0 && (
                          <div className="prompt-not">
                            Not: tool sonuç (role: tool) mesajlarının içeriği bu
                            görünümde saklanmaz; yalnızca yukarıdaki tool çağrı
                            argümanları kayıttan gösterilir.
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                {acikCikti === i && (
                  <tr className="prompt-satir">
                    <td colSpan={19}>
                      {ciktiGoruntu(m, ciktilar[i])}
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* -------- Özet tablosu -------- */}
      {sonucVar && (
        <>
          <div className="baslik-satir" style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 16 }}>
              Özet: saldırı × koşul (temiz referansa göre)
            </h2>
            <div className="satir" style={{ margin: 0 }}>
              <button onClick={ozetCsvIndir}>CSV indir</button>
              <button onClick={ozetMarkdownKopyala}>
                {ozetKopyalandi ? "Kopyalandı ✓" : "Markdown kopyala"}
              </button>
            </div>
          </div>
          <p className="altbaslik">
            Her satır bir (saldırı × koşul) hücresi. &quot;Kanıt değerleri&quot; = o
            saldırının kanıt sütununun N koşudaki değerleri; &quot;band dışı&quot; =
            kaç koşu temiz referans bandının dışında (mekanik kıyas; &quot;başarılı&quot;
            etiketi değil).
          </p>

          <div className="deney-tablo-sar">
            <table className="deney-tablo">
              <thead>
                <tr>
                  <th>saldırı</th>
                  <th>koşul</th>
                  <th title="koşu sayısı">N</th>
                  <th title="bu saldırının kanıt sütunu ve N koşudaki değerleri">
                    kanıt değerleri
                  </th>
                  <th title="kaç koşu temiz referans bandının dışında">band dışı</th>
                  <th title="temiz referansa göre ort. ek token">ort. ek tok</th>
                  <th title="temiz referansa göre ort. ek maliyet">ort. ek $</th>
                </tr>
              </thead>
              <tbody>
                {ozetSunum.map((o, i) => (
                  <tr key={i}>
                    <td title={o.saldiriAd}>
                      {o.saldiriId} — {o.saldiriAd}
                    </td>
                    <td className={o.savunma ? "evet" : "hayir"}>
                      {o.savunma ? "savunmalı" : "savunmasız"}
                    </td>
                    <td>{o.n}</td>
                    <td>
                      <span className="kanit-etiket">{o.kanitSutunu}:</span>{" "}
                      {o.degerler.join(", ")}
                    </td>
                    <td className={o.bandDisi > 0 ? "uyari" : ""}>
                      {o.bandDisi}/{o.n}
                    </td>
                    <td>
                      {o.ortEkToken > 0 ? "+" : ""}
                      {o.ortEkToken.toLocaleString("tr-TR")}
                    </td>
                    <td>
                      {o.ortEkUsd >= 0 ? "+" : ""}${o.ortEkUsd.toFixed(6)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* -------- Yan yana karşılaştırma (savunmasız vs savunmalı) -------- */}
          <h2 style={{ fontSize: 16, marginTop: 24 }}>
            Yan yana: savunmasız vs savunmalı (kanıt sütunu)
          </h2>
          <p className="altbaslik">
            Her saldırının kanıt sütunu değerleri iki koşulda yan yana; parantez
            içinde temiz referans bandı referans çizgisidir. Band dışı değerler{" "}
            <span className="uyari" style={{ fontWeight: 700 }}>
              kırmızı
            </span>
            .
          </p>
          <div className="kars-izgara">
            {SALDIRILAR.filter((s) =>
              metrikler.some((m) => m.saldiriId === s.id)
            ).map((s) => {
              const kanit = s.kanitSutunu;
              const kosulKart = (savunma: boolean) => {
                const hucre = metrikler.filter(
                  (m) => m.saldiriId === s.id && m.savunma === savunma
                );
                const b = savunma ? bantlar.savunmali : bantlar.savunmasiz;
                const aralik = b ? kanitBant(kanit, b) : null;
                return (
                  <div className="kars-kosul" key={String(savunma)}>
                    <div className="kars-kosul-baslik">
                      {savunma ? "savunmalı" : "savunmasız"}
                    </div>
                    <div className="kars-band">
                      temiz band:{" "}
                      {aralik ? `${aralik[0]}–${aralik[1]}` : "—"}
                    </div>
                    <div className="kars-cipler">
                      {hucre.map((m, j) => {
                        const v = kanitDeger(m, kanit);
                        const disi = aralik
                          ? bantYon(v, aralik[0], aralik[1]) !== null
                          : false;
                        return (
                          <span
                            className={`kars-cip ${disi ? "disi" : ""}`}
                            key={j}
                            title={disi ? "band dışı" : "band içi"}
                          >
                            {v}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                );
              };
              return (
                <div className="kars-kart" key={s.id}>
                  <div className="kars-kart-baslik">
                    {s.id} · {s.ad}{" "}
                    <span className="kanit-etiket">kanıt: {kanit}</span>
                  </div>
                  <div className="kars-kosullar">
                    {kosulKart(false)}
                    {kosulKart(true)}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}
