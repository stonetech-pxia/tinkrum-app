// Glossaries for receipt prefill rules (logic in rules.ts, rules-text.ts; D-403). Glossaries apply in all interface languages; the app does not know which country a receipt is from.

// ---- Totals: Japanese, Turkish ----
export const EXTRA_AMOUNT_KEYWORDS = ['合計', 'toplam', 'genel toplam', 'toplm'];
export const EXTRA_AMOUNT_EXCLUDE = ['小計', 'お預り', 'お預かり', 'お釣り', 'topkdv'];
/** Not a translation pair: put into constants first to prevent check-locales from treating these two words as a 'Chinese + English name pair'. */
// Not a translation pair: put into constants first to prevent check-locales from treating these two words as 'Chinese + English name pair'.
const CASH_JA = '現金';
export const AMOUNT_EXCLUDE_EXACT = [CASH_JA, 'nakit'];

// ---- Tax words: Japanese, Canadian HST, Spanish ----
export const EXTRA_TAX_KEYWORDS = [
  '消費税',
  '消费税',
  '消費税等',
  '消费税等',
  '外税',
  '内税',
  '内消費税',
  '外税額',
  '外税额',
  '外税計',
  '税額',
  'hst',
  'iva',
  'impuesto',
];

// ---- 'Total incl. tax', quantity, and tax rows are not totals; tax keywords ----
export const TAX_INCLUDED = /incl|inc\.|included|inclusive|with\s*tax|ttc|税込|含税/i;
export const TOTAL_WORD = /total|合计|总计|合計|總計/i;
export const AMOUNT_EXCLUDE_QTY_TAX = [
  'qty',
  'quantity',
  'items',
  '点数',
  '数量',
  'vat',
  'gst',
  'hst',
  'iva',
];
export const TAX_LABEL_WORD = /tax|vat|gst|hst|iva|税/i;

// ---- Tax labels consisting solely of VAT, GST letters (after removing prefix) ----
export const COMPACT_TAX = new Set(['vat', 'uat', 'gst', 'hst', 'tax', 'iva']);
export const COMPACT_TAX_PREFIX = ['sales', 'total', 'item', 'inclusive'];

// ---- Day-month order: when no other clues exist, these currencies have day first; USD requires $ or AM/PM for month first ----
export const DMY_FIRST_CURRENCY = ['EGP', 'TRY', 'BRL'];
export const MDY_IF_US_MARKER_CURRENCY = ['USD'];
export const US_MARKER = /\$|\b[AP]\.?M\b/i;

// ---- When these words appear to the left of a date, it indicates validity period or return deadline, not invoice date ----
export const NOT_ISSUE_DATE_LEFT =
  /有効期限|有効期間|有効|失効|までに取得|まで有効|return(?:s)?\s*(?:by|with|until|thru)|\bthru\b|through|last day|refund|exchange/i;

// ---- 'Printed' date label ----
export const PRINT_WORD = /print/i;

// ---- Title row (document name) ----
export const TITLE_WORDS_LATIN = [
  'tax invoice',
  'invoice',
  'receipt',
  'sales receipt',
  'cash receipt',
  'bill',
  'duplicate',
  'copy',
  'customer copy',
  'order details',
  'order',
  'fatura',
  'e-arsiv',
  'e-arşiv',
  'fis',
  'fiş',
  'adisyon',
  'satis',
  'satış',
];
export const TITLE_WORDS_CJK = [
  '領収書',
  '領収証',
  '領収',
  'レシート',
  'お買上',
  '御買上',
  '精算',
  '清算',
  '明細',
  '控',
  '伝票',
  '发票',
  '收据',
  '小票',
];

// ---- Store name prefix, labels ----
export const MERCHANT_PREFIX = [
  'welcome to ',
  'thank you for ordering from ',
  'thank you for shopping at ',
  'thank you for visiting ',
];
export const MERCHANT_LABEL = [
  'store name',
  'sold by',
  'merchant',
  'seller',
  'vendor',
  '事業者名',
  '加盟店',
  '店名',
];

// ---- Company suffixes ----
export const COMPANY_SUFFIX_LATIN = [
  'llc',
  'l.l.c',
  'ltd',
  'inc',
  'gmbh',
  'sdn bhd',
  's.a.e',
  's.a.',
  'a.s.',
  'a.ş.',
  'co.',
  'pty',
  'plc',
  'w.l.l',
];
export const COMPANY_SUFFIX_CJK = ['株式会社', '(株)', '（株）', '有限会社'];

// ---- Western language total and tax keywords (French, Spanish, German, Italian, with Portuguese, Dutch) ----
// Glossaries apply in all interface languages (the app does not know which country the receipt is from).
export const WEST_AMOUNT_KEYWORDS = [
  // fr
  'total ttc',
  'total à payer',
  'total general',
  'total facture',
  'montant total',
  'montant à payer',
  'total dû',
  'solde à payer',
  'total net',
  // es
  'total a pagar',
  'importe total',
  'total factura',
  'importe',
  'total euros',
  'a pagar',
  'total general',
  'suma total',
  'importe a pagar',
  'total venta',
  // de
  'summe',
  'gesamt',
  'gesamtsumme',
  'gesamtbetrag',
  'endbetrag',
  'endsumme',
  'zu zahlen',
  'zahlbetrag',
  'rechnungsbetrag',
  'bruttobetrag',
  'betrag',
  'gesamtpreis',
  // it
  'totale',
  'totale complessivo',
  'totale euro',
  'totale da pagare',
  'importo',
  'importo totale',
  'da pagare',
  'importo pagato',
  'totale fattura',
  'totale documento',
  'totale generale',
  // pt / nl
  'valor total',
  'total geral',
  'valor a pagar',
  'totaal',
  'totaal te betalen',
  'te betalen',
  'totaalbedrag',
  'totaal bedrag',
];
export const WEST_AMOUNT_EXCLUDE = [
  // fr: payment, change, net of tax
  'montant remis',
  'remis',
  'rendu',
  'reçu',
  'espèces',
  'sous total',
  'total ht',
  'dont tva',
  'monnaie',
  'acompte',
  'réduction',
  // es
  'base imponible',
  'cambio',
  'efectivo',
  'entregado',
  'cuota',
  'descuento',
  'recibido',
  'devolución',
  'dto',
  // de
  'zwischensumme',
  'netto',
  'nettobetrag',
  'mwst',
  'ust',
  'steuer',
  'rückgeld',
  'rueckgeld',
  'gegeben',
  'zurück',
  'rabatt',
  // it
  'subtotale',
  'imponibile',
  'resto',
  'contanti',
  'contante',
  'sconto',
  'arrotondamento',
  'di cui iva',
  // pt / nl
  'troco',
  'dinheiro',
  'desconto',
  'subtotaal',
  'btw',
  'wisselgeld',
  'contant',
  'korting',
];
export const WEST_TAX_KEYWORDS = [
  'dont tva',
  'montant tva',
  'taxe',
  'cuota iva',
  'i.v.a',
  'mehrwertsteuer',
  'umsatzsteuer',
  'enth. mwst',
  'enthaltene mwst',
  'mwst',
  'ust',
  'steuer',
  'di cui iva',
  'imposta',
  'btw',
  'omzetbelasting',
  'imposto',
];
export const WEST_TAX_EXCLUDE = [
  'base imponible',
  'imponibile',
  'base imposable',
  'netto',
  'nettobetrag',
  'zwischensumme',
  'subtotale',
  'subtotal',
  'totale',
  'gesamt',
  'summe',
  'total ttc',
  'subtotaal',
  'totaal',
];

// ---- Day-month order: EUR, GBP, VAT keywords, GST ----
/** When table currency is these, numeric dates with year at the end have day first (Eurozone, UK; synthetic data EUR 442/442, GBP 152/152 have day first). */
export const DMY_TABLE_CURRENCY = ['EUR', 'GBP'];
/** When these currency notations appear in text, the receipt is likely from a country with day-first dates (25/25 in wild+restaurant have day first). */
export const DMY_TEXT_CURRENCY = /€|£|\bEUR\b|\bGBP\b/;
/** VAT keywords (VAT, TVA, MwSt, IVA, I.V.A, BTW, USt); ignored if $ is present in the same text (US invoices also write VAT). */
export const VAT_WORD = /(^|[^A-Za-z])(?:VAT|TVA|MwSt|IVA|I\.V\.A|BTW|USt)(?![A-Za-z])/i;
/** Has GST but lacks HST, PST, QST (Canadian provincial taxes): likely a bill from Australia, New Zealand, India, or Singapore, where the day comes first. */
export const GST_WORD = /(^|[^A-Za-z])GST(?![A-Za-z])/;
export const CANADA_TAX_WORD = /(^|[^A-Za-z])(?:HST|PST|QST|TVQ)(?![A-Za-z])/;

// ======== Month names (lookup after removing accents and lowercasing) ========
const M = (m: number, ...names: string[]): [string, number][] => names.map((n) => [n, m]);
export const MONTHS_WEST: Record<string, number> = Object.fromEntries([
  ...M(
    1,
    'jan',
    'january',
    'janvier',
    'janv',
    'enero',
    'ene',
    'januar',
    'januari',
    'gennaio',
    'gen',
    'janeiro',
  ),
  ...M(
    2,
    'feb',
    'february',
    'fevrier',
    'fevr',
    'fev',
    'febrero',
    'februar',
    'februari',
    'febbraio',
    'fevereiro',
  ),
  ...M(3, 'mar', 'march', 'mars', 'marzo', 'marz', 'maerz', 'maart', 'mrt', 'marco'),
  ...M(4, 'apr', 'april', 'avril', 'avr', 'abril', 'abr', 'aprile'),
  ...M(5, 'may', 'mai', 'mayo', 'mei', 'maggio', 'mag', 'maio'),
  ...M(6, 'jun', 'june', 'juin', 'junio', 'juni', 'giugno', 'giu', 'junho'),
  ...M(7, 'jul', 'july', 'juillet', 'juil', 'julio', 'juli', 'luglio', 'lug', 'julho'),
  ...M(8, 'aug', 'august', 'aout', 'agosto', 'ago', 'augustus', 'agost'),
  ...M(
    9,
    'sep',
    'sept',
    'september',
    'septembre',
    'septiembre',
    'sep',
    'settembre',
    'set',
    'setembro',
  ),
  ...M(
    10,
    'oct',
    'october',
    'octobre',
    'octubre',
    'okt',
    'oktober',
    'ottobre',
    'ott',
    'out',
    'outubro',
  ),
  ...M(11, 'nov', 'november', 'novembre', 'noviembre', 'novembro'),
  ...M(
    12,
    'dec',
    'december',
    'decembre',
    'diciembre',
    'dic',
    'dez',
    'dezember',
    'dicembre',
    'dezembro',
  ),
]);
/** When getting the latest date on a hotel bill, dates following these keywords are print dates and should be ignored. */
export const PRINT_WORD_LEFT = /print|imprim|gedruckt|stampa|impres/i;

// ======== Merchant name: separate invoices and receipts ========
/** Terms common only on invoices (English, French, Spanish, German, Italian); counted as an invoice only if at least 2 different terms appear. */
export const INVOICE_TERMS: RegExp[] = [
  /bill(?:ed)?\s*to/,
  /sold\s*to/,
  /ship(?:ped)?\s*to/,
  /remit(?:tance)?\s*to/,
  /due\s*date/,
  /payment\s*terms/,
  /\bterms\b/,
  /net\s*\d+/,
  /purchase\s*order/,
  /\bp\.?\s?o\.?\s*(?:no|number|#)/,
  /amount\s*due/,
  /balance\s*due/,
  /invoice\s*(?:no|number|#|date)/,
  /\binvoice\b/,
  /bill\s*from/,
  /customer\s*(?:no|number|id)/,
  /\bcustomer\b/,
  /\bfacture\b/,
  /factur[ée]e?\s*[àa]\b/,
  /conditions\s*de\s*paiement/,
  /bon\s*de\s*commande/,
  /[ée]ch[ée]ance/,
  /\bfactura\b/,
  /fecha\s*de\s*vencimiento/,
  /condiciones\s*de\s*pago/,
  /orden\s*de\s*compra/,
  /\brechnung\b/,
  /rechnungs(?:nummer|datum)/,
  /zahlungsbedingungen/,
  /\bkunde\b/,
  /f[äa]llig/,
  /\bfattura\b/,
  /scadenza/,
  /condizioni\s*di\s*pagamento/,
];
export const INVOICE_MIN_TERMS = 2;
/** Seller labels on invoices (added only for invoices). */
export const SELLER_KEYWORDS = [
  'remit to',
  'payable to',
  'pay to',
  'make checks payable to',
  'make check payable to',
  'make payable to',
  'issued by',
  'supplier',
  'bill from',
  'from',
  'fournisseur',
  'émetteur',
  'proveedor',
  'emisor',
  'lieferant',
  'aussteller',
  'fornitore',
  'emittente',
];
/** Buyer labels (excluded on invoices). */
export const BUYER_EXCLUDE = [
  'bill to',
  'sold to',
  'ship to',
  'deliver to',
  'attn',
  'customer',
  'buyer',
  'facturer à',
  'livrer à',
  'client',
  'destinataire',
  'facturar a',
  'cliente',
  'enviar a',
  'rechnung an',
  'kunde',
  'lieferadresse',
  'fatturare a',
  'spedire a',
];
export const SELLER_WEIGHT = 1;
/** Words permitted before seller terms in labels (e.g., 'Please remit to', 'Invoice send remittance to'). */
export const SELLER_PREFIX = [
  'please',
  'send',
  'mail',
  'invoice',
  'all',
  'make',
  'our',
  'kindly',
  'payment',
  'remittance',
];

// ======== Issue date: dates with these terms in their labels are not issue dates (start, end, period, received, delivered...) ========
export const NOT_ISSUE_DATE_LABEL = [
  'start',
  'starting',
  'begin',
  'beginning',
  'end',
  'ending',
  'from',
  'through',
  'thru',
  'period',
  'run dates',
  'flight',
  'air date',
  'effective',
  'check date',
  'cheque',
  'delivery',
  'delivered',
  'shipped',
  'ship date',
  'shipping',
  'balance as of',
  'as of',
  'last update',
  'updated',
  'sent',
  'valid',
  'contract date',
  'début',
  'debut',
  'fin',
  'période',
  'periode',
  'livraison',
  'expédition',
  'réception',
  'validité',
  'inicio',
  'periodo',
  'vencimiento',
  'entrega',
  'envío',
  'recepción',
  'validez',
  'beginn',
  'ende',
  'zeitraum',
  'fällig',
  'fälligkeit',
  'lieferdatum',
  'lieferung',
  'versand',
  'gültig',
  'inizio',
  'fine',
  'scadenza',
  'consegna',
  'spedizione',
  'valido',
];

// ======== Tax terms: if none appear in the entire text, the bill has no tax indicated; unlabeled numbers are not treated as tax amounts ========
// Latin and Cyrillic alphabets require whole-word matching (excluding words like "taxi" or
// "relax"); CJK, Thai, and Arabic do not use space tokenization, and tax-related terms are often
// attached to other words (e.g., "consumption tax", Arabic "tax"), so substring matching is used.
// Recognizing extra words only reduces score by one at most, never adds extra candidates.
const TAX_WORDS_SPACED = [
  // en / fr / es / de / it / nl / pt (Portuguese 'icms' is Brazil's merchandise circulation tax)
  'tax',
  'taxes',
  'taxe',
  'vat',
  'gst',
  'hst',
  'pst',
  'qst',
  'tva',
  'iva',
  'mwst',
  'ust',
  'btw',
  'imposta',
  'imposte',
  'impuesto',
  'impuestos',
  'steuer',
  'mehrwertsteuer',
  'umsatzsteuer',
  'belasting',
  'tps',
  'tvq',
  'sales\\s+tax',
  'salestax',
  'imposto',
  'impostos',
  'icms',
  // Turkish ('verg[iİı]' is because uppercase 'İ' does not match 'i' case-insensitively), Polish,
  // Russian, Malay, Indonesian, Nordic languages, Czech, Hungarian, Finnish, Greek
  'kdv',
  'topkdv',
  'verg[iİı]',
  'ptu',
  'podat\\p{L}*',
  'ндс',
  'налог\\p{L}*',
  'pajak',
  'ppn',
  'pb1',
  'sst',
  'cukai',
  'moms',
  'mva',
  'dph',
  'áfa',
  'afa',
  'alv',
  'φπα',
];
const TAX_WORDS_UNSPACED = [
  // Chinese (including Traditional) and Japanese: consumption tax, tax amount, tax-included, tax
  '税',
  '稅',
  // Korean: value-added tax, value-added tax (full), tax, tax amount, consumption tax, taxation, tax exemption
  '부가세',
  '부가가치세',
  '세금',
  '세액',
  '소비세',
  '과세',
  '면세',
  // Arabic: tax (ضريبة, including with definite article 'ال'), taxes (ضرائب), VAT abbreviation (ض.ق.م), value-added tax (القيمة المضافة)
  'ضريب',
  'ضرائب',
  'ض\\.?\\s?ق\\.?\\s?م',
  'قيمة\\s+مضافة',
  // Thai, Vietnamese, Hebrew
  'ภาษี',
  'thuế',
  'מע["״]?מ',
];
export const TAX_WORD = new RegExp(
  `(^|[^\\p{L}])(?:${TAX_WORDS_SPACED.join('|')})(?![\\p{L}])|${TAX_WORDS_UNSPACED.join('|')}`,
  'iu',
);
