import express from 'express'
import Groq from 'groq-sdk'
import { Octokit } from '@octokit/rest'
import crypto from 'crypto'
import { createAppAuth } from '@octokit/auth-app'

const app = express()
const PORT = Number(process.env.PORT) || 3000
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

app.use(express.raw({ type: 'application/json' }))

function getAuthenticatedOctokit(installationId: number) {
  const privateKey = (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n')
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID,
      privateKey,
      installationId
    }
  })
}

async function getDiff(owner: string, repo: string, pull_number: number) {
  const octokit = new Octokit()
  const { data } = await octokit.pulls.get({
    owner, repo, pull_number,
    mediaType: { format: 'diff' }
  })
  return data as unknown as string
}

async function reviewCode(diff: string) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a senior software engineer doing a thorough code review.

Review the following code diff and provide detailed feedback. Structure your response with these sections:

## Summary
Brief overview of what the PR does.

## Issues Found
List any bugs, errors, or problems. Be specific about file and line.

## Security Concerns
Any security vulnerabilities or risks.

## Suggestions
Improvements for code quality, performance, or readability.

## Verdict
APPROVE, REQUEST CHANGES, or COMMENT with a brief reason.

Be specific, actionable, and helpful. If the change is minor (like a typo fix), keep the review short and positive.

Diff:
${diff}`
    }]
  })
  return completion.choices[0].message.content || 'No review generated.'
}

async function postReview(octokit: Octokit, owner: string, repo: string, pull_number: number, review: string) {
  await octokit.issues.createComment({
    owner, repo,
    issue_number: pull_number,
    body: `## 🤖 AI Code Review\n\n${review}\n\n---\n*Reviewed by PRGuard-ai*`
  })
}

app.post('/webhook', (req, res) => {
  const sig = req.headers['x-hub-signature-256'] as string
  const secret = process.env.WEBHOOK_SECRET || ''
  const hash = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex')
  
  if (sig !== hash) {
    console.log('❌ Invalid signature — request rejected')
    return res.status(401).send('Unauthorized')
  }

  res.status(200).send('OK')
  const event = req.headers['x-github-event'] as string
  try {
    const payload = JSON.parse(req.body.toString())
    if (event === 'pull_request' && payload.action === 'opened') {
      console.log('🔔 New PR:', payload.pull_request.title)
      const [owner, repo] = payload.repository.full_name.split('/')
      const installationId = payload.installation.id
      getDiff(owner, repo, payload.pull_request.number)
        .then(diff => reviewCode(diff))
        .then(review => {
          const octokit = getAuthenticatedOctokit(installationId)
          return postReview(octokit, owner, repo, payload.pull_request.number, review)
        })
        .then(() => console.log('✅ Review posted!'))
        .catch(err => console.error('Error:', err))
    }
  } catch (err) {
    console.error('Parse error:', err)
  }
})

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
  console.log(`   Waiting for GitHub webhooks...`)
})