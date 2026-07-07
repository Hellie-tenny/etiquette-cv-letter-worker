// Etiquette CV — AI cover letter proxy
// Takes CV data + job info from the client, calls Gemini server-side
// (so the API key never touches the browser), returns the generated letter.

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

function buildPrompt({ fullName, jobTitle, profileText, companyName, jobDescription }) {
  return `You are a professional career writing assistant. Write a concise, tailored cover letter based on the details below.

Candidate name: ${fullName}
Target role: ${jobTitle}
Company: ${companyName || 'the company'}

Candidate's CV / background (may be raw text extracted from a document, or a structured summary — treat it as the source of truth for their skills and experience):
${profileText}

Job description / posting details:
${jobDescription}

Write the cover letter in exactly three paragraphs:
1. A brief, specific opening stating the role and why the candidate is a strong fit.
2. A paragraph connecting the candidate's actual experience and skills to the specific requirements in the job description — be concrete, not generic.
3. A short closing paragraph expressing interest in an interview.

Rules:
- Do not invent facts, numbers, or experience not present in the candidate's CV/background above.
- Do not use placeholder brackets like [Company Name] — use the real values given.
- If the CV/background text is messy (e.g. extracted from a PDF), extract the relevant facts and ignore formatting artifacts, headers, or page numbers.
- Keep the tone professional and confident, not flowery.
- Output only the letter text, no preamble, no markdown formatting, no subject line.`
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) })
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      })
    }

    let body
    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      })
    }

    const { fullName, jobTitle, profileText, companyName, jobDescription } = body

    if (!fullName || !jobTitle || !profileText || !jobDescription) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } },
      )
    }

    // Cap the profile text length — protects against runaway prompt size/cost
    // from very large uploaded documents, and Gemini doesn't need more than this
    // to write a focused 3-paragraph letter.
    const trimmedProfileText = profileText.slice(0, 8000)

    const prompt = buildPrompt({ fullName, jobTitle, profileText: trimmedProfileText, companyName, jobDescription })

    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 1000,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      )

      if (!geminiRes.ok) {
        const errText = await geminiRes.text()
        console.error('Gemini API error:', geminiRes.status, errText)
        return new Response(
          JSON.stringify({ error: 'The AI service is temporarily unavailable. Please try again shortly.' }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } },
        )
      }

      const data = await geminiRes.json()
      const letter = data?.candidates?.[0]?.content?.parts?.[0]?.text

      if (!letter) {
        return new Response(
          JSON.stringify({ error: 'The AI did not return any content. Please try again.' }),
          { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } },
        )
      }

      return new Response(JSON.stringify({ letter: letter.trim() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      })
    } catch (err) {
      console.error('Worker error:', err)
      return new Response(
        JSON.stringify({ error: 'Something went wrong generating the letter.' }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } },
      )
    }
  },
}
