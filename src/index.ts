import express from 'express'
import Groq from 'groq-sdk'
import { Octokit } from '@octokit/rest'
import { createAppAuth } from '@octokit/auth-app'

const app = express()
const PORT = Number(process.env.PORT) || 3000
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

app.use(express.raw({ type: 'application/json' }))

function getAuthenticatedOctokit(installationId: number) {
  const privateKey = Buffer.from(process.env.GITHUB_PRIVATE_KEY || '', 'base64').toString('utf8')
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
    messages: [{
      role: 'user',
      content: `You are a senior software engineer reviewing a pull request.
Analyze the following code diff and return ONLY a JSON array. No other text.
Each item: { "path": string, "line": number, "suggestion": string, "comment": string }
If no suggestions, return [].
Diff:\n${diff}`
    }]
  })
  const text = completion.choices[0].message.content || '[]'
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch {
    return []
  }
}

async function postReview(octokit: Octokit, owner: string, repo: string, pull_number: number, commitSha: string, suggestions: any[]) {
  if (suggestions.length === 0) {
    await octokit.issues.createComment({ owner, repo, issue_number: pull_number, body: '## 🤖 AI Code Review\n\nNo issues found! ✅\n\n---\n*PRGuard-ai*' })
    return
  }
  await octokit.pulls.createReview({
    owner, repo, pull_number,
    commit_id: commitSha,
    event: 'COMMENT',
    body: '## 🤖 AI Code Review\n\n---\n*PRGuard-ai*',
    comments: suggestions.map(s => ({ path: s.path, line: s.line, body: `${s.comment}\n\`\`\`suggestion\n${s.suggestion}\n\`\`\`` }))
  })
}

app.post('/webhook', (req, res) => {
  res.status(200).send('OK')
  const event = req.headers['x-github-event'] as string
  try {
    const payload = JSON.parse(req.body.toString())
    if (event === 'pull_request' && payload.action === 'opened') {
      console.log('🔔 New PR:', payload.pull_request.title)
      const [owner, repo] = payload.repository.full_name.split('/')
      const installationId = payload.installation.id
      const commitSha = payload.pull_request.head.sha
      getDiff(owner, repo, payload.pull_request.number)
        .then(diff => reviewCode(diff))
        .then(suggestions => {
          const octokit = getAuthenticatedOctokit(installationId)
          return postReview(octokit, owner, repo, payload.pull_request.number, commitSha, suggestions)
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
