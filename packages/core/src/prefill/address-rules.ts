import type { CardDoc, Unit } from './card-rules';
import { hasCompany, hasJob } from './card-rules';
import type { ValueSuggestion } from './rank';

// Business card address candidates (rules A-01–A-08). No negative lookbehinds; fully synchronous;
// does not write data or use network. Multi-line addresses connected with \\n. A-01 Multi-line
// joining (street line + postal/city line + country/floor line) A-02 Postal code and city format
// (France/Spain/Germany/Italy/Austria/Switzerland/UK/US/Canada/Australia/Portugal/Netherlands/Brazil...)
// A-03 Multilingual street terms + house number position (including abbreviations) A-04 Label terms
// (address/adresse/dirección/indirizzo/anschrift/morada/address...), strip labels; single-line
// labels take the next line A-05 Exclude traps (street terms in company names/slogans, service
// areas, phone, email, website lines) A-06 Chinese/Japanese/Korean addresses
// (province/city/district/road/street/number/building/room, numbers can be Chinese characters,
// traditional Chinese) A-07 Drop miscellaneous candidates from general scoring (job titles, domain
// names, etc. in address field) A-08 Cut off phone numbers/websites at the end of address lines

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const squash = (s: string) => fold(s).replace(/[^\p{L}\p{N}]/gu, '');
const CJK = /[㐀-鿿]/;
const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯]/;

// ---------- Labels ----------
const LAB_PREFIX =
  '(?:(?:postal|mailing|business|office|studio|street|home|visiting|registered|billing|company|head\\s*office)\\s+)?';
// Full word: separators after it are optional
const LABEL_FULL = new RegExp(
  `^${LAB_PREFIX}(?:address|adresse|adres|direcci[oó]n|direccion|domicilio|indirizzo|anschrift|besuchsadresse|postanschrift|morada|endere[cç]o|moradia)(?:\\s+(?:postale|comercial|fiscal|legale|professionnelle))?\\s*[:：.\\-–—|]*\\s*`,
  'i',
);
// Short form: must have : or . to be considered a label (Add: , Addr. , A:)
const LABEL_SHORT = /^(?:addr|add|adr|dir|ind)\s*[:：.]\s*|^A\s*[:：]\s*/i;
const LABEL_CJK =
  /^[一-鿿]{0,4}(?:地\s*址|住\s*址|通訊處|通讯处|廠址|厂址|所在地|住所)\s*[:：]?\s*/;
const LABEL_KO = /^주소\s*[:：]?\s*/;
const LABEL_JA = /^〒?\s*(?:住所|所在地)\s*[:：]?\s*/;

/** Strip leading symbols and labels; returns text and whether it has a label (labelOnly = label occupies a line by itself). */
function stripLabel(t0: string): { text: string; labeled: boolean; labelOnly: boolean } {
  let t = t0
    .trim()
    .replace(/^[\s•·▪■◆►▶➤✦★☆📍🏠•*>~|-]+/u, '')
    .trim();
  for (const re of [LABEL_FULL, LABEL_SHORT, LABEL_CJK, LABEL_KO, LABEL_JA]) {
    const m = t.match(re);
    if (m && m[0].length > 0) {
      const rest = t.slice(m[0].length).trim();
      // Short form A: must still have content afterwards (or be standalone)
      return { text: rest, labeled: true, labelOnly: rest.length === 0 };
    }
  }
  return { text: t, labeled: false, labelOnly: false };
}

// ---------- Non-address lines ----------
const CONTACT_LABEL =
  /^(?:tel|tél|tlf|telf|telefon|telefono|teléfono|telefone|phone|ph|mob|mobile|móvil|movil|portable|cell|cel|celular|handy|fax|whatsapp|email|e-mail|mail|courriel|correo|web|www|site|url|电话|電話|手机|手機|傳真|传真|邮箱|郵箱|電郵|网址|網址|携帯|メール|이메일)\b\s*[.:：]?/i;
const CONTACT_CJK =
  /^(?:电话|電話|手机|手機|傳真|传真|邮箱|郵箱|電郵|网址|網址|携帯|メール|이메일)/;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const URLISH =
  /(?:https?:\/\/|www\.)\S+|(?:^|[\s/(])[a-z0-9][a-z0-9-]*\.(?:com|net|org|info|biz|eu|fr|es|de|it|pt|nl|ch|at|be|uk|co|io|ca|us|au|br|ar|mx|cn|tw|hk|jp|kr|ma|tn|ae|app|dev|shop|studio|design|agency|online|site)(?:\/\S*)?(?=$|[\s,;)])/i;
const SLOGAN =
  /(?:^|[^a-z])(?:since|established|founded|depuis|desde|seit|sinds|serving|proudly|we|our|your|nous|votre|notre|nuestro|nuestra|unser|unsere|wir|ihr|vous|you|open|hours|horaires|service area|services?|emergency|24\/7|24\s*(?:h|horas|std|stunden|heures|uur|ore)\b|livrons|atendemos|ofrecemos)(?:$|[^a-z])|服務地區|服务地区|服務範圍|服务范围|營業時間|营业时间|提供|歡迎|欢迎/i;
const LEGAL =
  /(?:^|[^a-z0-9])(?:ltd|limited|llc|llp|inc|corp|gmbh|ag|sarl|sas|sasu|srl|spa|bv|nv|pty|plc|lda|ltda|s\.a\.|s\.l\.)\.?(?=$|[^a-z0-9])/;

function phoneLike(t: string): boolean {
  const digits = (t.match(/\d/g) ?? []).length;
  const body = t.replace(/\s+/g, '').length;
  if (/^\+?\(?\d[\d\s().\-/]{5,}$/.test(t.trim())) return true;
  return digits >= 7 && digits > 0.6 * body;
}

// ---------- Street terms ----------
// Street nouns before the name (French/Spanish/Italian/Portuguese): long forms appear freely; short forms must have . or /
const PRE_LONG = new Set(
  'rue avenue boulevard impasse chemin quai allee cours passage voie route calle avenida avda avd paseo carrer camino cmno carretera ctra ronda travesia glorieta urbanizacion poligono carrera diagonal transversal rua travessa alameda estrada rodovia praceta beco via viale piazza piazzale vicolo strada lungomare lungotevere contrada localita plaza praca largo place square bd bvd blvd bld rte lungarno corso rambla vial'.split(
    ' ',
  ),
);
const AMBIG_PRE = new Set(
  'cours place square passage voie route largo plaza rambla vial diagonal transversal'.split(' '),
);
const PRE_SHORT = new Set(
  'r c cl ch pl pza pso ps pc tv dg cr cra kra est rod res all urb pol loc v vle cso av avda avd bd cmno ctra trv pzza'.split(
    ' ',
  ),
);
// English: street name first, term last
const EN_STRONG = new Set(
  'street avenue ave road rd boulevard blvd lane ln highway hwy parkway pkwy terrace crescent cres'.split(
    ' ',
  ),
);
const EN_WEAK = new Set(
  'drive dr court ct place pl way circle cir close square sq trail trl alley row mews gardens gdns grove wharf plaza park hill walk pike path loop promenade quay gate parade rise green yard embankment broadway circus approach'.split(
    ' ',
  ),
);
// German/Dutch: compound word suffix
const COMPOUND =
  /^[a-zß-]{2,}(?:strasse|straße|str|platz|weg|allee|gasse|ring|damm|ufer|chaussee|steig|pfad|markt|straat|laan|gracht|plein|singel|kade|dijk|steeg|baan|hof)$/;
const DE_WORD = new Set('strasse straße str platz weg allee gasse'.split(' '));
const NL_WORD = new Set('singel laan plein gracht kade dijk steeg straat weg'.split(' '));
const DE_WORD_NUM = new Set(['ring', 'damm', 'ufer']); // Standalone words: only count if followed by a house number (Kärntner Ring 5)
const CONNECT = new Set(
  'de del della delle di da do dos das du des la le el los las y e et and of the van von der den ten ter d l saint sainte san santa sao são st'.split(
    ' ',
  ),
);
const DE_PARTICLE =
  /^(?:Am|An der|An den|Auf dem|Auf der|Im|In der|Zum|Zur|Unter den|Hinter dem|Beim)\s+\p{Lu}[\p{L}'’.-]*/u;
// Route numbers directly following route nouns (Route 66), not house numbers
const ROUTE_WORD = new Set('route rte ruta highway hwy autobahn rodovia'.split(' '));
const POBOX =
  /(?:^|[^a-z])(?:p\.?\s?o\.?\s*box|postfach|apartado(?:\s+(?:de\s+correos|postal))?|casilla(?:\s+de\s+correo)?|caixa\s+postal|case\s+postale|casella\s+postale|postbus|b\.?p\.?|c\.?s\.?|cedex)\s*n?[º°o]?\.?\s*\d+/i;

const HN =
  /^(?:n[º°o]?|nr|no|num|núm|#)?\.?#?(\d{1,5}[a-zA-Z]?(?:\s?[-–/]\s?\d{1,5}[a-zA-Z]?)?)\.?$/i;
const HN_MARK = /^(?:n[º°o]?|nr|no|num|núm|#)\.?$/i;
const HN_NONE = new Set(['s/n', 'snc', 's.n.', 's.n', 'sn']);

function tokenize(t: string): string[] {
  return t
    .replace(/\b(St|Rd|Ave|Str|Av|Blvd|Dr|Ln)\.(?=\d)/g, '$1. ')
    .replace(/(^|\s)P[º°]\.?(?=\s)/g, '$1Paseo')
    .split(/[\s,;|]+/)
    .filter(Boolean);
}
const key = (tok: string) =>
  fold(tok)
    .replace(/\./g, '')
    .replace(/[:/]+$/, '');
const isCap = (tok: string) => /^[A-ZÀ-ÖØ-Þ0-9]/.test(tok);
const isOrdinal = (tok: string) => /^\d+(?:st|nd|rd|th|e|er|ème|eme|ª|º|°)$/i.test(tok);

/** Words between HN and street nouns look like names (capitalized, digits, conjunctions), unlike lowercase words in slogans. */
function nameTokensOk(tok: string[], from: number, to: number): boolean {
  for (let j = from; j < to; j++) {
    const w = tok[j]!;
    if (
      isCap(w) ||
      CONNECT.has(key(w).replace(/['’]$/, '')) ||
      /^[a-z]\.?$/i.test(w) ||
      /^(?:n|no|nr|#)[º°o.]?\d*$/i.test(w) ||
      /^(?:bis|ter|quater)$/i.test(w)
    )
      continue;
    return false;
  }
  return true;
}
/** House number: returns position, -1 if none. tok is token array, searched within from..to range. */
function findHN(tok: string[], from: number, to: number): number {
  for (let j = Math.max(0, from); j <= Math.min(tok.length - 1, to); j++) {
    const k = key(tok[j]!);
    if (HN_NONE.has(k)) return j;
    if (HN_MARK.test(k) && j + 1 < tok.length && /^\d/.test(tok[j + 1]!)) return j + 1;
    if (isOrdinal(tok[j]!)) continue;
    const m = tok[j]!.match(HN);
    if (!m) continue;
    const digits = m[1]!.replace(/\D/g, '');
    if (/^\d{5,}$/.test(m[1]!) && !/^(?:n|no|nr|#)/i.test(tok[j]!)) continue; // 5-digit numbers treated as postal codes unless accompanied by No./#
    if (digits.length > 5) continue;
    // Route number
    if (j > 0 && ROUTE_WORD.has(key(tok[j - 1]!))) continue;
    return j;
  }
  return -1;
}

// ---------- Postal code and city ----------
const P_STRONG: RegExp[] = [
  /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/, // UK
  /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/, // Canada
  /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/, // US state + postal code
  /\b\d{4}-\d{3}\b/, // Portugal
  /\b\d{5}-\d{3}\b/, // Brazil
  /\b[1-9]\d{3}\s?[A-Z]{2}\b/, // Netherlands
  /\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/, // Australia
  /\b(?:CH|AT|A|BE|B|LU|L|DK|NO|SE|FI|DE|D|FR|F|ES|E|IT|I|PL|MA|TN|DZ|NL|PT|P)\s?[-–]\s?\d{4,5}\b/, // CH-8001 and similar
  /\b(?:c\.?\s?p\.?|cep|plz|zip|npa|cap|code\s+postal)\s*:?\s*\d{4,6}\b/i,
  /\b[A-Z]\d{4}[A-Z]{3}\b/, // Argentina C1425ABC
  /\b\d{2}-\d{3}\b/, // Poland
];
const P5 = /(?:^|[^\d])(\d{5})(?!\d)/;
const P4 = /(?:^|[^\d])([1-9]\d{3})(?!\d)/;
const NOT_POSTAL =
  /(?:^|[^a-z])(?:siret|siren|rcs|vat|tva|nif|cif|iban|bic|tin|ein|reg|nr|no|n°|id|cnpj|cpf|ape|naf|capital|code|tel|fax|tél)\b/i;

function hasStrongPostal(t: string): boolean {
  return P_STRONG.some((re) => re.test(t));
}
/** Line looks like "postal code + city": strong format, or 5 digits + city term; ctx4 = 4 digits also counts if preceded by a street line. */
function postalCity(t: string, ctx4: boolean): boolean {
  if (
    t.length > 70 ||
    t.length < 4 ||
    EMAIL.test(t) ||
    URLISH.test(t) ||
    /[€$£¥]|\b(?:eur|euros?|usd|gbp)\b/i.test(t)
  )
    return false;
  if (CONTACT_LABEL.test(t) && !/^zip|^cap|^plz|^npa/i.test(t)) return false;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (letters < 2)
    return (
      hasStrongPostal(t) && /^[A-Z]\d[A-Z]?\s?\d[A-Z]{2}$|^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/.test(t.trim())
    );
  if (hasStrongPostal(t)) return true;
  const m5 = t.match(P5);
  if (m5 && !NOT_POSTAL.test(t.slice(0, Math.max(0, t.indexOf(m5[1]!))))) {
    const rest = t.replace(m5[1]!, ' ');
    return /[A-Za-zÀ-ÖØ-öø-ÿ]{3,}/.test(rest);
  }
  if (ctx4 && /^[A-ZÀ-ÖØ-Þ][\p{L} .'’-]{2,30}\s*(?:[-–,]\s*[A-Z]{2}|\([A-Z]{2}\))$/u.test(t.trim()))
    return true; // Rio de Janeiro - RJ / Milano (MI)
  if (ctx4 && /\b[A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?\s*[-,]?\s*\d{6}\b/.test(t) && t.length <= 40)
    return true; // Singapore 048616 / Hyderabad 500034
  if (ctx4) {
    const m4 = t.match(P4);
    if (m4 && !NOT_POSTAL.test(t.slice(0, Math.max(0, t.indexOf(m4[1]!)))))
      return /[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'’.-]{2,}|[A-ZÀ-ÖØ-Þ]{3,}/.test(t.replace(m4[1]!, ' '));
  }
  return false;
}
/** Postal code is within the line (regardless of whether city is present). */
function postalIn(t: string): boolean {
  return hasStrongPostal(t) || (P5.test(t) && !NOT_POSTAL.test(t.replace(/\d{5}.*/, '')));
}

const COUNTRIES = new Set(
  'france germany deutschland allemagne alemania alemanha italy italia italie spain espana espagne españa portugal switzerland suisse schweiz svizzera suiza suica austria osterreich autriche belgium belgique belgien belgica belgie netherlands nederland pays-bas holland paises-bajos luxembourg luxemburg united-kingdom uk england scotland wales ireland irlanda irlande usa united-states america canada australia australie brasil brazil bresil argentina argentine mexico mexique chile colombia peru uruguay maroc morocco marokko maroc tunisie tunisia algerie algeria egypt egypte sweden suede denmark norway finland poland pologne greece turkey japan china chine taiwan hong-kong singapore korea india uae iraq'
    .split(' ')
    .map((c) => c.replace(/-/g, ' ')),
);
function countryLine(t: string): boolean {
  const f = fold(t)
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!f || f.length > 30) return false;
  if (COUNTRIES.has(f)) return true;
  return false;
}
const UNIT_LINE =
  /^(?:suite|ste|unit|floor|fl|level|bldg|building|room|rm|apt|apartment|bat|batiment|immeuble|etage|escalier|piso|planta|puerta|oficina|of|local|edificio|edificacao|sala|interno|int|scala|piano|stock|raum|haus|zimmer|tower|torre|bloc|bloco|lote|andar|c\/o|co)\b/;
const BUILDING_LINE =
  /^(?:immeuble|batiment|bat\.|residence|edificio|edif\.|building|bldg|torre|tower|edificacao|gebaeude|centre|centro|center|parc|zone|zac|zi|za|domaine|lotissement|poligono|pol\. ind\.|parque|gewerbepark|industriegebiet|business park|industrial estate|science park|campus)\s+\S/;
function unitLine(t: string): boolean {
  if (
    BUILDING_LINE.test(fold(t)) &&
    t.length <= 40 &&
    !EMAIL.test(t) &&
    !URLISH.test(t) &&
    !hasCompany(t)
  )
    return true;
  const f = fold(t).replace(/^[\s.]+/, '');
  return (
    f.length <= 40 &&
    UNIT_LINE.test(f.replace(/\./g, '')) &&
    /\d|[a-z]/.test(f) &&
    !EMAIL.test(t) &&
    !URLISH.test(t) &&
    !phoneLike(t)
  );
}

// ---------- Street line determination ----------
interface Street {
  ok: boolean;
  /** Has street term but no house number or postal code (counts as an address only if the next line is postal code/city). */
  weak?: boolean;
  /** Evidence strength: house number + street term = 3; street term + postal code = 2.8; PO box = 2.5 */
  s: number;
}
const NO: Street = { ok: false, s: 0 };

const SAINT = /\b(?:St|Dr)\.?\s+[A-ZÀ-Þ][a-zà-ÿ]/;
function streetLine(t: string): Street {
  if (t.length < 5 || t.length > 90) return NO;
  const tok = tokenize(t);
  if (tok.length < 2 || tok.length > 14) return NO;
  const postal = postalIn(t);
  let weakSeen = false;
  if (POBOX.test(t)) return { ok: true, s: 2.5 };
  const hn0 = findHN(tok, 0, 1);
  // German prepositions: Am Markt 5
  if (DE_PARTICLE.test(t) && findHN(tok, 1, 5) >= 0) return { ok: true, s: 3 };
  for (let i = 0; i < tok.length; i++) {
    const k = key(tok[i]!);
    const raw = tok[i]!;
    // English: street noun last
    if (i >= 1 && (EN_STRONG.has(k) || EN_WEAK.has(k) || k === 'st' || k === 'dr')) {
      if (
        (k === 'st' || k === 'dr') &&
        SAINT.test(t) &&
        i + 1 < tok.length &&
        isCap(tok[i + 1]!) &&
        !/^\d/.test(tok[i + 1]!) &&
        !unitLine(tok.slice(i + 1).join(' '))
      )
        continue; // St. Gallen (separated by commas does not count)
      if (k === 'dr' && i < 2) continue;
      if (i > 6) continue;
      if (hn0 >= 0 && hn0 < i && nameTokensOk(tok, hn0 + 1, i)) return { ok: true, s: 3 };
      const weak = EN_WEAK.has(k) || k === 'dr' || k === 'st';
      const strongWord =
        !weak || (k === 'st' && findHN(tok, i + 1, i + 1) === i + 1 && nameTokensOk(tok, 0, i));
      if (strongWord) {
        const trail = findHN(tok, i + 1, i + 3);
        if (
          postal ||
          (trail >= 0 && /^(?:#|no|nr|n[º°o])/i.test(tok[trail - 1] ?? '')) ||
          (trail >= 0 && trail === i + 1 && !/^\d{1,2}$/.test(tok[trail]!.replace(/\D/g, '')))
        )
          return { ok: true, s: postal ? 2.8 : 2.6 };
        if (trail >= 0) return { ok: true, s: 2.6 };
        if (i <= 5) weakSeen = true;
      }
      continue;
    }
    // Prefix type: Rue/Calle/Via/Rua..., within tokens 0–3
    const shortOk = PRE_SHORT.has(k) && /[./]/.test(raw);
    // 1 route de Genève: house number immediately precedes the street noun (can have other words before it, Bureaux de la Colline, 1 route de Genève)
    if (
      i >= 2 &&
      i <= 9 &&
      (PRE_LONG.has(k) || shortOk) &&
      findHN(tok, i - 1, i - 1) === i - 1 &&
      !/^\d{5,}$/.test(tok[i - 1]!)
    )
      return { ok: true, s: 2.9 };
    if (i <= 3 && (PRE_LONG.has(k) || shortOk)) {
      if (
        i >= 1 &&
        !(
          hn0 >= 0 ||
          unitLine(tok.slice(0, i).join(' ')) ||
          /^(?:local|oficina|torre|piso|bloc|edificio|edif|sala|loja|suite|unit)$/i.test(
            key(tok[0]!),
          )
        )
      ) {
        // Street noun is neither at line start nor follows house number: must have house number or postal code
        if (findHN(tok, i + 1, i + 6) < 0 && !postal) continue;
      }
      if (i >= 1 && !nameTokensOk(tok, 0, i)) continue; // Dal 1990 in Via Roma
      if (ROUTE_WORD.has(k) && hn0 < 0 && !postal) {
        // Route 66 Diner: route number not followed by another house number
        if (findHN(tok, i + 2, i + 6) < 0) continue;
      }
      const after = findHN(tok, i + 1, i + 7);
      if (hn0 >= 0 && hn0 < i) return { ok: true, s: 3 };
      if (after >= 0 && AMBIG_PRE.has(k) && !postal) {
        // Cours de cuisine - 8 places: when common nouns are used as street nouns, only commas, units, or end can follow the house number
        const at = t.indexOf(tok[after]!, t.indexOf(raw));
        const tail = t.slice(at + tok[after]!.length).trim();
        if (tail && !/^[,;–—-]|^(?:bis|ter)\b|^[A-Za-z]{1,3}\b/i.test(tail)) continue;
      }
      if (after >= 0 && after < tok.length - 4 && !postal && findHN(tok, after + 1, tok.length) < 0)
        continue; // Long string following house number: slogans, store names
      if (after >= 0 && /^(?:18|19|20)\d\d$/.test(tok[after]!) && after > i + 2 && !postal)
        continue; // Calle Real Bodegas 1895
      if (after >= 0) {
        // Calle 8 Tapas Bar: street noun immediately followed by 1–2 digits without No./# marker, followed by capitalized words not separated by commas, is a store name not an address
        if (after === i + 1 && /^\d{1,2}$/.test(tok[after]!) && !postal) {
          const at = t.indexOf(tok[after]!, t.indexOf(raw));
          const tail = t.slice(at + tok[after]!.length).trim();
          if (
            tail &&
            !/^[,;–—-]|^#|^(?:bis|ter|no|nr|n[º°o])\b\.?|^(?:de|do|da|of|di|del|des|du)\s/i.test(
              tail,
            )
          )
            continue;
        }
        return { ok: true, s: 3 };
      }
      if (postal) return { ok: true, s: 2.8 };
      if (i === 0 && !AMBIG_PRE.has(k)) weakSeen = true;
      continue;
    }
    // German standalone Ring / Damm / Ufer
    if (i >= 1 && DE_WORD_NUM.has(k) && isCap(raw) && findHN(tok, i + 1, i + 2) === i + 1)
      return { ok: true, s: 3 };
    // Dutch standalone street nouns: Singel 250, Laan van Meerdervoort 100 (must have house number)
    if (
      i <= 1 &&
      NL_WORD.has(k) &&
      isCap(raw) &&
      !(i === 0 && /^(?:straat|weg|dijk|steeg)$/.test(k)) &&
      findHN(tok, i + 1, i + 4) >= 0
    )
      return { ok: true, s: 2.8 };
    // German-Dutch compound words
    if (i <= 4 && (COMPOUND.test(k.replace(/\.$/, '')) || DE_WORD.has(k))) {
      if (DE_WORD.has(k) && i === 0) continue; // "Straße" alone at the beginning is not a street name
      const after = findHN(tok, i + 1, i + 3);
      if (after >= 0 && (after === i + 1 || (after === i + 2 && HN_MARK.test(tok[i + 1]!))))
        return { ok: true, s: 3 };
      if (hn0 >= 0 && hn0 < i) return { ok: true, s: 3 };
      if (postal) return { ok: true, s: 2.8 };
      if (i <= 2 && !DE_WORD.has(k)) weakSeen = true;
    }
  }
  return weakSeen ? { ok: false, s: 0, weak: true } : NO;
}

// ---------- Chinese, Japanese, and Korean ----------
const ADM = /[省市縣县區区鄉乡鎮镇村里郡]/g;
const ROAD = /[路街道段巷弄]|大道|大街|胡同|開發區|开发区|園區|园区/;
const NUMM = /[號号樓楼室座棟栋層层]/;
const CNNUM = /[〇零一二三四五六七八九十百]/;
const FLOOR_CJK =
  /^[0-9A-Za-z\-之]*[樓楼層层室座棟栋Ff]\s*\d*[-之]?\d*[室號号]?$|^\d+[樓楼Ff層层](?:之\d+)?$|^[A-Za-z]?\d*[座棟栋]\d*(?:[樓楼層层]\d*)?$/;
const BLDG_CJK =
  /^[\u4e00-\u9fffA-Za-z0-9 -]{2,12}(?:大廈|大厦|大樓|大楼|廣場|广场|中心|園區|园区|大院)?[A-Za-z0-9 -]*(?:座|棟|栋|層|层|樓|楼|室|F)$/;
const CO_END_CJK =
  /(?:有限公司|股份有限公司|公司|集團|集团|事務所|事务所|工作室|株式会社|有限会社|診所|诊所|醫院|医院|銀行|银行|商行)$/;
function cjkAddress(t: string): number {
  // Returns score, 0 = no
  if (t.length < 5 || t.length > 70) return 0;
  const adm = (t.match(ADM) ?? []).length;
  const cls = (adm > 0 ? 1 : 0) + (ROAD.test(t) ? 1 : 0) + (NUMM.test(t) ? 1 : 0);
  const num = /\d/.test(t) || CNNUM.test(t);
  if (KANA.test(t) || HANGUL.test(t)) return cjkJaKo(t);
  if (!CJK.test(t)) return 0;
  if (jobLikeCjk(t) || SLOGAN.test(t)) return 0;
  if (CO_END_CJK.test(t.replace(/[\s.。]+$/, '')) && cls < 3) return 0;
  if (
    /(?:餐厅|餐廳|分店|店|門市|门市|商行|診所|诊所|公司)$/.test(t.replace(/[\s.。]+$/, '')) ||
    /^[路街道巷弄號号]/.test(t)
  )
    return 0;
  if (cls >= 2 && num) return 2 + (cls === 3 ? 0.5 : 0) + 0.5;
  if (adm >= 2 && ROAD.test(t)) return 2.5;
  return 0;
}
const jobLikeCjk = (t: string) => hasJob(t) && !ROAD.test(t);
function cjkJaKo(t: string): number {
  if (KANA.test(t) || /[一-鿿]/.test(t)) {
    // Japanese: 〒, prefectures/cities/wards/towns/villages + chome-ban-go/street + numbers
    const adm = /[都道府県市区町村郡]/.test(t);
    const road = /丁目|番地|番|号|通り|町/.test(t);
    if ((t.includes('〒') || adm) && (road || /\d/.test(t)) && /\d/.test(t)) return 2.5;
    return 0;
  }
  if (HANGUL.test(t)) {
    // Korean: si/gu/dong/ro/gil + numbers
    if (/[가-힣]+(?:로|길|대로|동|구|시)\s*\d+/.test(t)) return 2.5;
  }
  return 0;
}

// ---------- Overall line evaluation ----------
interface Line {
  u: Unit;
  text: string; // After removing labels and trailing parts
  labeled: boolean;
  labelOnly: boolean;
  street: Street;
  cjk: number;
  postal: boolean;
  postalCity: boolean;
  bad: boolean; // Contact info line
}

const CUT_TAIL =
  /\s*(?:[-–—|•·,;/]\s*)?(?:\b(?:tel|tél|tlf|telf|phone|mob|mobile|fax|cel|móvil|portable)\b\.?\s*[:.]?\s*\+?\(?\d|\b(?:e-?mail|www|https?)\b|\bt\s*[:.]\s*\+?\d|\bf\s*[:.]\s*\+?\d|@|[\w-]+\.(?:com|net|org|fr|es|de|it|pt|nl|ch|co\.uk)\b).*$/i;

function prepLine(u: Unit): Line {
  const lab = stripLabel(u.text);
  let text = lab.text;
  // "Visit us: 15 Rose Lane..." : Short prefix + colon, followed by recognizable street line
  if (!lab.labeled) {
    const pm = text.match(/^([^\d:：]{2,18})[:：]\s*(.{6,})$/);
    if (
      pm &&
      !CONTACT_LABEL.test(pm[1]!.trim() + ':') &&
      (streetLine(pm[2]!).ok || cjkAddress(pm[2]!) > 0)
    )
      text = pm[2]!.trim();
  }
  // Phone/URL at the end of an address line
  if (text.length > 8) {
    const m = text.match(CUT_TAIL);
    if (m && m.index !== undefined && m.index >= 6) text = text.slice(0, m.index).trim();
  }
  text = text.replace(/[\s,;|]+$/, '').trim();
  let bad = false;
  if (CONTACT_LABEL.test(u.text.trim()) && !lab.labeled) bad = true;
  if (CONTACT_CJK.test(u.text.trim()) && !lab.labeled) bad = true;
  if (EMAIL.test(text) || URLISH.test(text)) bad = true;
  if (phoneLike(text)) bad = true;
  const sloganHit = SLOGAN.test(text) && !postalIn(text) && !/,/.test(text);
  let street = bad || sloganHit ? NO : streetLine(text);
  // Company/store names containing street words: exclude those without commas and postal codes (Park Avenue Design Studio, 3 Avenue Hotel)
  if (
    street.ok &&
    !postalIn(text) &&
    !/,/.test(text) &&
    (hasCompany(text) || LEGAL.test(fold(text)))
  )
    street = NO;
  const cjk = bad ? 0 : cjkAddress(text);
  const pc = !bad && postalCity(text, false);
  return {
    u,
    text,
    labeled: lab.labeled,
    labelOnly: lab.labelOnly,
    street,
    cjk,
    postal: postalIn(text),
    postalCity: pc,
    bad,
  };
}

/** Line b is immediately below a (small vertical gap, and aligned left, center, or right). */
function below(a: Unit, b: Unit): boolean {
  if (a.page !== b.page) return false;
  const hh = Math.max(a.h, b.h);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  if (dy <= 0.4 * hh || dy > 2.6 * hh) return false;
  if (Math.min(a.h, b.h) / hh < 0.55) return false;
  return (
    Math.abs(a.x - b.x) < 3 * hh ||
    Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) < 3 * hh ||
    Math.abs(a.x + a.w - (b.x + b.w)) < 3 * hh
  );
}

export function addressCandidates(doc: CardDoc): ValueSuggestion[] {
  const units = doc.units
    .filter((u) => u.src === 'cell')
    .slice()
    .sort((a, b) => a.page - b.page || a.y + a.h / 2 - (b.y + b.h / 2));
  const lines = units.map(prepLine);
  const out: { v: string; s: number; relY: number; row: number; used: number[] }[] = [];

  // Single line or multi-line: starting from i
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]!;
    if (L.bad && !L.labeled) continue;
    let head = L;
    let headIdx = i;
    let score = 0;
    let parts: string[] = [];
    const used: number[] = [i];
    if (L.labelOnly) {
      // Label on a separate line: value taken from the next line (immediately following)
      const nx = lines[i + 1];
      if (
        !nx ||
        nx.bad ||
        !below(L.u, nx.u) ||
        !/\p{L}|\d/u.test(nx.text) ||
        (nx.labeled && nx.labelOnly)
      )
        continue;
      if (CJK.test(nx.text) && nx.cjk === 0 && !nx.postalCity) {
        // Recognize values following Chinese labels even if formatting is incomplete
      }
      head = nx;
      headIdx = i + 1;
      used.push(i + 1);
      score = 4;
      parts = [nx.text];
    } else if (
      !L.street.ok &&
      !L.bad &&
      (L.street.weak ||
        ((BUILDING_LINE.test(fold(L.text)) ||
          /^(?:unit|units|suite|office|room|floor|level)\s+\d/i.test(L.text)) &&
          L.text.length <= 40)) &&
      !(hasCompany(L.text) || hasJob(L.text) || LEGAL.test(fold(L.text))) &&
      lines[i + 1] &&
      !lines[i + 1]!.bad &&
      below(L.u, lines[i + 1]!.u) &&
      postalCity(lines[i + 1]!.text, true)
    ) {
      // Only street words without house number, but next line is postal code and city (The Old Mill, Mill Lane / London...)
      score = 2.4;
      parts = [L.text];
    } else if (L.street.ok) {
      score = L.street.s + (L.labeled ? 1 : 0);
      parts = [L.text];
    } else if (L.cjk > 0) {
      score = L.cjk + (L.labeled ? 1 : 0);
      parts = [L.text];
    } else if (L.labeled && L.text.length >= 3 && /\p{L}|\d/u.test(L.text)) {
      // Has label, unrecognized value format (Address: Gorriti 5062, Palermo): recognized
      score = 3.5;
      parts = [L.text];
    } else continue;

    // Single-line postal code and city already in the street line: do not duplicate
    if (!L.labelOnly && L.street.ok && postalIn(L.text)) score += 0.3;

    // Multi-line joining: fetch postal code, city, country, and floor downwards
    let last = headIdx;
    let sawPostal = postalIn(head.text);
    let sawCountry = false;
    for (let k = last + 1; k < lines.length && parts.length < 4; k++) {
      const N = lines[k]!;
      if (N.bad || !below(lines[last]!.u, N.u)) break;
      if (N.labeled && !N.labelOnly) break; // Another labeled line
      const cjkHere = head.cjk > 0 || CJK.test(head.text);
      let take = false;
      if (cjkHere) {
        // Chinese: floor, room, building (zuo)
        const nt = N.text.replace(/\s+/g, '');
        take =
          (FLOOR_CJK.test(nt) ||
            (BLDG_CJK.test(N.text.trim()) &&
              /[\d〇零一二三四五六七八九十]/.test(nt) &&
              !CO_END_CJK.test(nt))) &&
          N.text.length <= 16 &&
          !sawCountry;
      } else if (!sawPostal && postalCity(N.text, true)) {
        take = true;
        sawPostal = true;
      } else if (!sawPostal && !sawCountry && unitLine(N.text)) take = true;
      else if (
        !sawPostal &&
        !sawCountry &&
        bridgeCity(N.text) &&
        lines[k + 1] &&
        !lines[k + 1]!.bad &&
        below(N.u, lines[k + 1]!.u) &&
        postalCity(lines[k + 1]!.text, true)
      )
        take = true;
      else if (
        !sawCountry &&
        (sawPostal || parts.length >= 1) &&
        countryLine(N.text) &&
        (sawPostal || parts.length >= 2)
      ) {
        take = true;
        sawCountry = true;
      }
      if (!take) break;
      parts.push(N.text);
      used.push(k);
      last = k;
    }
    // Floor/building line immediately above the street line (Building B / Immeuble X)
    if (L.street.ok && i > 0 && !L.labelOnly) {
      const P = lines[i - 1]!;
      if (
        !P.bad &&
        below(P.u, L.u) &&
        unitLine(P.text) &&
        !P.street.ok &&
        P.text.length <= 32 &&
        (BUILDING_LINE.test(fold(P.text)) || /\d|\b[A-Z]\b/.test(P.text))
      ) {
        // Merge only when the line above genuinely resembles a building or floor (Suite 5 / Building 4)
        parts = [P.text, ...parts];
        used.unshift(i - 1);
        score += 0;
      }
    }
    const v = parts.join('\n');
    out.push({
      v,
      s: score + (parts.length > 1 ? 0.5 : 0),
      relY: head.u.relY,
      row: head.u.row,
      used,
    });
    // Give only to the first of the block; the street-only version is appended later
    if (parts.length > 1)
      out.push({
        v: head.text,
        s: score - 0.2,
        relY: head.u.relY,
        row: head.u.row,
        used: [headIdx],
      });
  }

  // Sorting and deduplication (inclusion relationship: if short is included in long, do not keep separately unless it is the second candidate produced by merging)
  out.sort((a, b) => b.s - a.s || a.row - b.row);
  const res: typeof out = [];
  for (const o of out) {
    const k = squash(o.v);
    if (!k) continue;
    if (res.some((r) => squash(r.v) === k)) continue;
    res.push(o);
    if (res.length >= 3) break;
  }
  return res.map((o) => ({
    value: o.v,
    score: o.s,
    pick: { label: '', relY: Math.round(o.relY * 1000) / 1000 },
  }));
}

// City on a single line (London / Milano (MI)): merge into address only when immediately followed by a postal code line
function bridgeCity(t: string): boolean {
  const s = t.trim();
  if (s.length < 3 || s.length > 28 || /\d/.test(s) || EMAIL.test(s) || URLISH.test(s))
    return false;
  if (!/^[A-ZÀ-ÖØ-Þ]/.test(s)) return false;
  if (hasJob(s) || hasCompany(s)) return false;
  return s.split(/\s+/).length <= 3;
}
