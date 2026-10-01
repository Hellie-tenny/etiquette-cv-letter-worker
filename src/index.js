// Etiquette CV — AI cover letter proxy
// Handles three actions:
//   "extract"        — pulls job title, company, and apply instructions out of a pasted job listing
//                     (text or a photo). With purpose:"posting" it also returns location, employment
//                     type, closing date, and a cleaned description for the Post a Job form.
//   "extractContact"  — pulls email/phone/address out of an uploaded CV, for the letterhead
//   "generate"        — writes the cover letter body (default if no action given)
// The Gemini key never touches the browser — all actions call Gemini
// server-side, using a key stored only in this Worker's secrets.

const ALLOWED_ORIGINS = [
  'https://ettiquette-cv.web.app',
  'http://localhost:5173', // Vite dev server, for local testing
]

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

async function callGemini(env, promptOrParts, { maxOutputTokens, temperature }) {
  const parts = typeof promptOrParts === 'string' ? [{ text: promptOrParts }] : promptOrParts

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature,
          maxOutputTokens,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    },
  )

  if (!res.ok) {
    const errText = await res.text()
    console.error('Gemini API error:', res.status, errText)
    throw new Error('gemini_error')
  }

  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('gemini_empty')
  return text.trim()
}

function buildExtractPrompt(jobText) {
  return `Extract details from the job listing text below. The text may include navigation menus, "Apply Now" buttons, cookie notices, or other unrelated page content — ignore all of that.

Respond with ONLY a JSON object, no markdown formatting, no code fences, no explanation — exactly this shape:
{"jobTitle": "...", "companyName": "...", "applyMethod": "...", "applyInstructions": "...", "applyContact": "..."}

Field rules:
- jobTitle: the role's title. Empty string "" if not identifiable.
- companyName: the hiring company. Empty string "" if not mentioned or you're not confident.
- applyMethod: one of "email", "link", "address", "other", or "" if the text doesn't describe how to apply.
- applyInstructions: a short, plain-language summary of how to apply (e.g. "Email your CV and cover letter with the subject line 'IT Officer Application'" or "Apply through the online portal"). Empty string "" if no application method is described.
- applyContact: the literal email address, URL, or physical address to apply to or through — copied EXACTLY as it appears in the text. Empty string "" if none is present. Never invent, guess, or complete a partial contact detail — only include one if it appears verbatim in the text.

Never guess or invent any value you're not reasonably confident about — use empty strings instead.

Job listing text:
${jobText}`
}

const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contract', 'Internship']
const DESCRIPTION_DELIMITER = '===DESCRIPTION==='

// Used for job photos (any caller) and for pasted text from the Post a Job form.
// The cleaned description comes AFTER a delimiter instead of inside the JSON, so a
// long multi-line description can't break JSON escaping or get the JSON cut off.
function buildFullExtractPrompt({ today, jobText }) {
  const source = jobText
    ? `the job listing text at the bottom of this message`
    : `the attached image of a job vacancy`
  return `Read ${source} and extract the details below. The source may contain navigation menus, "Apply Now" buttons, cookie notices, share links, unrelated postings, or other page clutter — ignore all of that.

Today's date is ${today}.

Respond in exactly this layout:
1) A single-line JSON object — no markdown, no code fences — with exactly these keys:
{"jobTitle": "", "companyName": "", "location": "", "employmentType": "", "closingDate": "", "applyMethod": "", "applyInstructions": "", "applyContact": ""}
2) A line containing only: ${DESCRIPTION_DELIMITER}
3) The cleaned job description as plain text.

JSON field rules:
- jobTitle: the role's title. "" if not identifiable.
- companyName: the hiring organisation. "" if not mentioned or you're not confident.
- location: the job's location (city/town/district), short. "" if not stated.
- employmentType: exactly one of ${EMPLOYMENT_TYPES.map((t) => `"${t}"`).join(', ')}, or "" if not stated. Map fixed-term/temporary/consultancy to "Contract"; attachment/traineeship/internship to "Internship".
- closingDate: the application deadline as YYYY-MM-DD, or "" if none is stated. Dates in the source are usually written day-first (e.g. 05/11/2026 is 5 November 2026). If the year is missing, use the next occurrence of that date on or after today. Never invent a date.
- applyMethod: one of "email", "link", "address", "other", or "" if the source doesn't say how to apply.
- applyInstructions: plain-language instructions on how to apply, keeping every specific requirement (subject line, documents to attach, what to include). "" if none.
- applyContact: the literal email address, URL, or postal address to apply through, copied EXACTLY as written. "" if none. Never invent, guess, or complete a partial contact detail.

Description rules:
- Include only the actual job content: about the role/organisation, duties and responsibilities, requirements, qualifications, skills, salary and benefits if stated.
- Leave out the how-to-apply paragraph and the closing-date sentence (they are captured above), and all page clutter.
- Keep the original wording — do not summarise, rewrite, or add anything. Fix only obvious line-break and spacing damage from copy/paste or OCR.
- Plain text only, no markdown symbols. Separate sections with a blank line. Use "- " at the start of each bullet item.

Never guess a value you're not reasonably confident about — use "" instead.
${jobText ? `\nJob listing text:\n${jobText}` : ''}`
}

function parseFullExtract(raw) {
  const idx = raw.indexOf(DESCRIPTION_DELIMITER)
  const jsonPart = idx >= 0 ? raw.slice(0, idx) : raw
  const descPart = idx >= 0 ? raw.slice(idx + DESCRIPTION_DELIMITER.length) : ''
  const fields = parseJsonFromGemini(jsonPart)
  if (!fields) return null
  const description = descPart.replace(/^\s*\n/, '').replace(/```\s*$/, '').trim()
  return { fields, description }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function normalizeEmploymentType(v) {
  const key = str(v).toLowerCase().replace(/[^a-z]/g, '')
  const map = { fulltime: 'Full-time', parttime: 'Part-time', contract: 'Contract', internship: 'Internship' }
  return map[key] || ''
}

// Accepts only a real calendar date in YYYY-MM-DD form.
function normalizeDate(v) {
  const s = str(v)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return ''
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : ''
}

function buildLetterPrompt({ fullName, jobTitle, profileText, companyName, jobDescription, notes }) {
  return `You are a professional career writing assistant. Write the BODY of a cover letter based on the details below. Do NOT include a greeting ("Dear..."), a closing ("Sincerely..."), a subject line, or the candidate's name — only the body paragraphs. Those parts are added separately by the application, not by you.

Candidate name: ${fullName}
Target role: ${jobTitle}
Company: ${companyName || 'the company'}

Candidate's CV / background (may be raw text extracted from a document, or a structured summary — treat it as the source of truth for their skills and experience):
${profileText}

Job posting (this may be a clean job description, or the full text of a job listing page — including navigation text, "Apply Now" buttons, company boilerplate, cookie notices, or other unrelated page content. Identify and use only the actual role details: responsibilities, requirements, and qualifications. Ignore everything else):
${jobDescription}
${notes ? `\nAdditional instructions from the candidate — follow these unless they conflict with the rules below:\n${notes}\n` : ''}
Write exactly three body paragraphs, separated by a blank line:
1. A brief, specific opening stating the role and why the candidate is a strong fit.
2. A paragraph connecting the candidate's actual experience and skills to the specific requirements in the job description — be concrete, not generic.
3. A short closing paragraph expressing interest in an interview.

Rules:
- Do not invent facts, numbers, or experience not present in the candidate's CV/background above.
- Do not use placeholder brackets like [Company Name] — use the real values given.
- If the CV/background text is messy (e.g. extracted from a PDF), extract the relevant facts and ignore formatting artifacts, headers, or page numbers.
- If the job posting text contains unrelated page content (navigation, boilerplate, unrelated postings), extract only the details relevant to this specific role and ignore the rest.
- Keep the tone professional and confident, not flowery, unless the candidate's additional instructions above say otherwise.
- Output ONLY the three body paragraphs, nothing else — no greeting, no closing, no signature, no subject line, no markdown formatting.`
}

function parseJsonFromGemini(raw) {
  // Gemini sometimes wraps JSON in markdown fences despite instructions not to.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    console.error('JSON parse failed:', cleaned)
    return null
  }
}

function buildContactExtractPrompt(cvText) {
  return `Extract the candidate's contact details from the CV/resume text below.

Respond with ONLY a JSON object, no markdown formatting, no code fences, no explanation — exactly this shape:
{"email": "...", "phone": "...", "address": "..."}

Field rules:
- email: the candidate's email address, copied exactly as it appears. Empty string "" if none is present.
- phone: the candidate's phone number, copied exactly as it appears. Empty string "" if none is present.
- address: the candidate's postal/physical address (e.g. organization name, P.O. Box, city) if present — copy it as a short comma-separated line. Empty string "" if none is present.

Never invent or guess a value that isn't actually in the text.

CV/resume text:
${cvText}`
}

async function handleExtract(body, env, origin) {
  const { jobText, jobImage, purpose } = body
  const isPosting = purpose === 'posting'

  // ── Photo of a vacancy (cover letter tool and Post a Job) ──
  if (jobImage) {
    const { data, mimeType } = jobImage
    if (
      typeof data !== 'string' ||
      !data ||
      typeof mimeType !== 'string' ||
      !mimeType.startsWith('image/') ||
      data.length > 7_500_000 // ~5MB file once base64-encoded
    ) {
      return jsonResponse({ error: 'That image could not be read. Try a different one.' }, 400, origin)
    }
    return runFullExtract(
      env,
      origin,
      [{ text: buildFullExtractPrompt({ today: todayISO(), jobText: '' }) }, { inline_data: { mime_type: mimeType, data } }],
      '',
    )
  }

  if (!jobText || jobText.trim().length < 30) {
    return jsonResponse({ error: 'Paste a bit more of the job listing first.' }, 400, origin)
  }

  // ── Pasted text from the Post a Job form: full extraction + cleaned description ──
  if (isPosting) {
    const trimmed = jobText.slice(0, 12000)
    return runFullExtract(env, origin, buildFullExtractPrompt({ today: todayISO(), jobText: trimmed }), trimmed)
  }

  // ── Pasted text from the cover letter tool: unchanged lightweight extraction ──
  const trimmedJobText = jobText.slice(0, 8000)

  try {
    const raw = await callGemini(env, buildExtractPrompt(trimmedJobText), {
      maxOutputTokens: 200,
      temperature: 0.1,
    })

    const parsed = parseJsonFromGemini(raw)
    if (!parsed) {
      return jsonResponse({ jobTitle: '', companyName: '' }, 200, origin)
    }

    return jsonResponse(
      {
        jobTitle: str(parsed.jobTitle),
        companyName: str(parsed.companyName),
        applyMethod: str(parsed.applyMethod),
        applyInstructions: str(parsed.applyInstructions),
        applyContact: str(parsed.applyContact),
      },
      200,
      origin,
    )
  } catch {
    return jsonResponse(
      { error: 'Could not read details from that listing. You can fill them in manually.' },
      502,
      origin,
    )
  }
}

function todayISO() {
  return new Date().toISOString().slice(0, 10)
}

// Shared by the photo path and the Post a Job paste path.
// sourceText is the pasted text (so contact details can be verified against it); '' for images.
async function runFullExtract(env, origin, promptOrParts, sourceText) {
  try {
    const raw = await callGemini(env, promptOrParts, { maxOutputTokens: 4096, temperature: 0.1 })
    const result = parseFullExtract(raw)
    if (!result) {
      return jsonResponse(
        { error: 'Could not read details from that listing. You can fill them in manually.' },
        502,
        origin,
      )
    }

    const f = result.fields
    let applyContact = str(f.applyContact)
    // Pasted text lets us check that the contact detail really appears in it.
    if (sourceText && applyContact && !sourceText.toLowerCase().includes(applyContact.toLowerCase())) {
      applyContact = ''
    }

    return jsonResponse(
      {
        jobTitle: str(f.jobTitle),
        companyName: str(f.companyName),
        location: str(f.location),
        employmentType: normalizeEmploymentType(f.employmentType),
        closingDate: normalizeDate(f.closingDate),
        applyMethod: applyContact ? str(f.applyMethod) : '',
        applyInstructions: str(f.applyInstructions),
        applyContact,
        extractedText: result.description,
      },
      200,
      origin,
    )
  } catch {
    return jsonResponse(
      { error: 'Could not read details from that listing. You can fill them in manually.' },
      502,
      origin,
    )
  }
}

async function handleExtractContact(body, env, origin) {
  const { cvText } = body

  if (!cvText || cvText.trim().length < 30) {
    return jsonResponse({ email: '', phone: '', address: '' }, 200, origin)
  }

  const trimmedCvText = cvText.slice(0, 8000)

  try {
    const raw = await callGemini(env, buildContactExtractPrompt(trimmedCvText), {
      maxOutputTokens: 150,
      temperature: 0.1,
    })

    const parsed = parseJsonFromGemini(raw)
    if (!parsed) {
      return jsonResponse({ email: '', phone: '', address: '' }, 200, origin)
    }

    return jsonResponse(
      {
        email: typeof parsed.email === 'string' ? parsed.email.trim() : '',
        phone: typeof parsed.phone === 'string' ? parsed.phone.trim() : '',
        address: typeof parsed.address === 'string' ? parsed.address.trim() : '',
      },
      200,
      origin,
    )
  } catch {
    // Non-critical — just fall back to empty, manual entry still works.
    return jsonResponse({ email: '', phone: '', address: '' }, 200, origin)
  }
}

async function handleGenerate(body, env, origin) {
  const { fullName, jobTitle, profileText, companyName, jobDescription, notes } = body

  if (!fullName || !jobTitle || !profileText || !jobDescription) {
    return jsonResponse({ error: 'Missing required fields' }, 400, origin)
  }

  // Cap all free-text inputs — protects against runaway prompt size/cost from
  // very large uploaded documents, full job listing pages, or long notes.
  const trimmedProfileText = profileText.slice(0, 8000)
  const trimmedJobDescription = jobDescription.slice(0, 8000)
  const trimmedNotes = (notes || '').slice(0, 1000)

  const prompt = buildLetterPrompt({
    fullName,
    jobTitle,
    profileText: trimmedProfileText,
    companyName,
    jobDescription: trimmedJobDescription,
    notes: trimmedNotes,
  })

  try {
    const letter = await callGemini(env, prompt, { maxOutputTokens: 1000, temperature: 0.7 })
    return jsonResponse({ letter }, 200, origin)
  } catch {
    return jsonResponse(
      { error: 'The AI service is temporarily unavailable. Please try again shortly.' },
      502,
      origin,
    )
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) })
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin)
    }

    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400, origin)
    }

    if (body.action === 'extract') {
      return handleExtract(body, env, origin)
    }

    if (body.action === 'extractContact') {
      return handleExtractContact(body, env, origin)
    }

    return handleGenerate(body, env, origin)
  },
}
