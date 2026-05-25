const { Octokit } = require("@octokit/rest");
require('dotenv').config();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;
const branch = process.env.GITHUB_BRANCH;

class GitHubDB {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async read() {
    try {
      const { data } = await octokit.repos.getContent({
        owner, repo, path: this.filePath, ref: branch
      });
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return JSON.parse(content);
    } catch (err) {
      if (err.status === 404) return [];
      throw err;
    }
  }

  async write(data) {
    let sha = null;
    try {
      const { data: file } = await octokit.repos.getContent({
        owner, repo, path: this.filePath, ref: branch
      });
      sha = file.sha;
    } catch (err) {}
    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: this.filePath, message: `Update ${this.filePath}`, content, sha, branch
    });
  }

  async findUserByEmail(email) {
    const users = await this.read();
    return users.find(u => u.email === email);
  }

  async addUser(user) {
    const users = await this.read();
    users.push(user);
    await this.write(users);
    return user;
  }

  async updateUser(email, update) {
    const users = await this.read();
    const index = users.findIndex(u => u.email === email);
    if (index !== -1) {
      users[index] = { ...users[index], ...update };
      await this.write(users);
    }
  }
}

module.exports = { GitHubDB };