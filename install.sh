#!/bin/bash
set -e

# Historia — One-click install script
# Usage: curl -fsSL https://raw.githubusercontent.com/YOUR_USER/historia/main/install.sh | bash

echo ""
echo "╔══════════════════════════════════════╗"
echo "║        Historia — Installer          ║"
echo "║  Cinematic Documentary Generator     ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || {
  echo "❌ Node.js is required but not installed."
  echo "   Install it: https://nodejs.org/ or via nvm:"
  echo "   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "   nvm install 20"
  exit 1
}

command -v npm >/dev/null 2>&1 || {
  echo "❌ npm is required but not installed."
  echo "   It usually comes with Node.js."
  exit 1
}

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "⚠️  Node.js 18+ is required (you have v$(node -v))"
  echo "   Run: nvm install 20"
  exit 1
fi

echo "✅ Node.js $(node -v) detected"
echo "✅ npm $(npm -v) detected"
echo ""

# Clone or check directory
if [ -d ".git" ] && [ -f "package.json" ]; then
  echo "📂 Already in project directory"
else
  echo "📂 Cloning Historia..."
  if [ -z "$1" ]; then
    echo "   Usage: ./install.sh <git-url>"
    echo "   Or run from inside the cloned repo"
    exit 1
  fi
  git clone "$1" historia
  cd historia
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

# Setup environment
if [ ! -f ".env" ]; then
  echo ""
  echo "⚙️  Creating .env file..."
  cat > .env << 'EOF'
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_PUBLISHABLE_KEY=your_supabase_anon_key
EOF
  echo "   ⚠️  Edit .env with your Supabase credentials"
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         ✅ Install Complete!         ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "  1. Start the dev server:"
echo "     npm run dev"
echo ""
echo "  2. Open http://localhost:5173"
echo ""
echo "  3. Go to Settings and configure:"
echo "     • Groq API Key    → console.groq.com"
echo "     • Whisk Cookie    → labs.google (browser cookie)"
echo "     • Inworld API Key → inworld.ai"
echo ""
echo "  4. Use 'Test All Connections' to verify"
echo ""
echo "  5. Create your first project! 🎬"
echo ""
