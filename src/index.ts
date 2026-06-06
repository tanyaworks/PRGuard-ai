import express from 'express'
import Groq from 'groq-sdk'
import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'
import * as dotenv from 'dotenv'
import * as fs from 'fs'

dotenv.config()

const app = express()
const PORT = Number(process.env.PORT) || 3000
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

app.use(express.raw({ type: 'application/json' }))

function getAuthenticatedOctokit(installationId: number) {
  const privateKey = process.env.GITHUB_PRIVATE_KEY!.replace(/\\n/g, "\n")
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID!,
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
    messages: [{
      role: 'user',
      content: `You are a senior software engineer reviewing a pull request.
Analyze the following code diff and return ONLY a JSON array. No other text.

Each item in the array should have:
- "path": the file path (from the diff header)
- "line": the line number being changed (the + line number)
- "suggestion": the improved code to replace that line with
- "comment": a brief explanation of why

Example output:
[
  {
    "path": "README.md",
    "line": 5,
    "suggestion": "# Tanya Jha Portfolio",
    "comment": "Should be an H1 heading"
  }
]

If there are no suggestions, return an empty array: []

Diff:
${diff}`
    }]
  })
  const text = completion.choices[0].message.content || '[]'
  try {
    const clean = text.replace(/\`\`\`json|\`\`\`/g, '').trim()
    return JSON.parse(clean)
  } catch {
    console.log('Could not parse JSON, returning empty')
    return []
  }
}

async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number,
  commitSha: string,
  suggestions: Array<{path: string, line: number, suggestion: string, comment: string}>
) {
  if (suggestions.length === 0) {
    await octokit.issues.createComment({
      owner, repo,
      issue_number: pull_number,
      body: '## 🤖 AI Code Review\n\nNo issues found! Code looks good. ✅\n\n---\n*Reviewed by PRGuard-ai*'
    })
    console.log('✅ No issues comment posted!')
    return
  }

  const comments = suggestions.map(s => ({
    path: s.path,
    line: s.line,
    body: `${s.comment}\n\`\`\`suggestion\n${s.suggestion}\n\`\`\``
  }))

  await octokit.pulls.createReview({
    owner, repo, pull_number,
    commit_id: commitSha,
    event: 'COMMENT',
    body: '## 🤖 AI Code Review\n\nHere are my suggestions:\n\n---\n*Reviewed by PRGuard-ai*',
    comments
  })
  console.log(`✅ Review posted with ${suggestions.length} inline suggestions!`)
}

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'] as string
  try {
    const payload = JSON.parse(req.body.toString())
   if (event === 'pull_request' && payload.action === 'opened') {
      res.status(200).send('OK')  // Respond immediately!
      
      console.log('\n🔔 New PR opened!')
      console.log(`  Repo  : ${payload.repository.full_name}`)
      console.log(`  PR #  : ${payload.pull_request.number}`)
      console.log('\n⏳ Fetching diff and reviewing...\n')

      const [owner, repo] = payload.repository.full_name.split('/')
      const installationId = payload.installation.id
      const commitSha = payload.pull_request.head.sha

      const diff = await getDiff(owner, repo, payload.pull_request.number)
      const suggestions = await reviewCode(diff)
      const octokit = getAuthenticatedOctokit(installationId)
      await postReview(octokit, owner, repo, payload.pull_request.number, commitSha, suggestions)
    } else {
      console.log(`📨 Event: ${event} (${payload.action || ''})`)
    }
    
  } catch (err) {
    console.error('Error:', err)
    res.status(200).send('OK')
  }
})

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`)
  console.log(`   Waiting for GitHub webhooks...\n`)
})