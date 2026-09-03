// Etiquette CV — AI cover letter proxy
// Handles three actions:
//   "extract"        — pulls job title, company, and apply instructions out of a pasted job listing
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

async function callGemini(env, prompt, { maxOutputTokens, temperature }) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
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
  const { jobText } = body

  if (!jobText || jobText.trim().length < 30) {
    return jsonResponse({ error: 'Paste a bit more of the job listing first.' }, 400, origin)
  }

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
        jobTitle: typeof parsed.jobTitle === 'string' ? parsed.jobTitle.trim() : '',
        companyName: typeof parsed.companyName === 'string' ? parsed.companyName.trim() : '',
        applyMethod: typeof parsed.applyMethod === 'string' ? parsed.applyMethod.trim() : '',
        applyInstructions: typeof parsed.applyInstructions === 'string' ? parsed.applyInstructions.trim() : '',
        applyContact: typeof parsed.applyContact === 'string' ? parsed.applyContact.trim() : '',
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
