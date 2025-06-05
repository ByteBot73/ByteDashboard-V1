require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const axios = require('axios');
const path = require('path');
const cookieParser = require('cookie-parser');

const app = express();

// Session setup
app.use(session({
  secret: process.env.SESSION_SECRET || 'supersecret',
  resave: false,
  saveUninitialized: false
}));

// Passport setup
app.use(passport.initialize());
app.use(passport.session());

// Cookie parser middleware
app.use(cookieParser());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Always fetch and attach user's guilds during login
passport.use(new DiscordStrategy({
  clientID: process.env.DISCORD_CLIENT_ID,
  clientSecret: process.env.DISCORD_CLIENT_SECRET,
  callbackURL: process.env.DISCORD_CALLBACK_URL,
  scope: ['identify', 'guilds']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const guildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    profile.guilds = guildsRes.data;
    return done(null, profile);
  } catch (err) {
    if (err.response && err.response.status === 429) {
      // Attach a custom property to signal rate limit
      profile.rateLimited = true;
      return done(null, profile);
    }
    return done(err, profile);
  }
}));

// Serve static files (for your HTML/CSS/JS)
app.use('/styles', express.static(path.join(__dirname, 'styles')));
app.use(express.static(path.join(__dirname)));

// Home page (static HTML)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Discord OAuth2 login
app.get('/login', passport.authenticate('discord'));
app.get('/callback', (req, res, next) => {
  passport.authenticate('discord', { failureRedirect: '/' }, (err, user, info) => {
    if (user && user.rateLimited) {
      // Show user-friendly rate limit page
      return res.redirect('/login-rate-limit');
    }
    if (err || !user) {
      return res.redirect('/');
    }
    req.logIn(user, (err) => {
      if (err) return res.redirect('/');
      res.redirect('/servers');
    });
  })(req, res, next);
});

// Logout
app.get('/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});

// API: Get user info
app.get('/api/user', (req, res) => {
  if (!req.isAuthenticated()) return res.json({ user: null });
  res.json({ user: req.user });
});

// In-memory cache for bot's guilds
let botGuildsCache = [];
let botGuildsCacheTime = 0;
const BOT_GUILDS_CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
let botGuildsCacheStale = false; // Track if cache is stale due to rate limit

// API: Get user's owned guilds with bot presence info
app.get('/api/guilds', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not logged in' });
  try {
    const now = Date.now();
    let botGuilds;
    if ((now - botGuildsCacheTime < BOT_GUILDS_CACHE_DURATION && !botGuildsCacheStale) || botGuildsCache.length === 0) {
      botGuilds = botGuildsCache;
      console.log('Bot is in guilds (from cache):', botGuilds);
    } else {
      // Get bot's guilds from Discord API
      try {
        const botGuildsRes = await axios.get('https://discord.com/api/v10/users/@me/guilds', {
          headers: { Authorization: `Bot ${process.env.BOT_TOKEN}` }
        });
        // Log the full error response if not 200
        if (botGuildsRes.status !== 200) {
          console.error('Bot guilds API non-200 response:', botGuildsRes.status, botGuildsRes.data);
        }
        // Log the full response for debugging
        console.log('Bot guilds API response:', botGuildsRes.data);
        botGuilds = botGuildsRes.data.map(g => g.id);
        botGuildsCache = botGuilds;
        botGuildsCacheTime = now;
        botGuildsCacheStale = false;
        console.log('Bot is in guilds:', botGuilds);
      } catch (err) {
        // Log the full error response from Discord
        if (err.response) {
          console.error('Discord API error:', err.response.status, err.response.data);
        } else {
          console.error('Discord API error:', err);
        }
        if (err.response && err.response.status === 429) {
          botGuildsCacheStale = true; // Mark cache as stale
          // Serve stale cache if available
          if (botGuildsCache.length > 0) {
            botGuilds = botGuildsCache;
          } else {
            return res.status(429).json({ error: 'Rate limited by Discord. Please try again in a few minutes.' });
          }
        } else {
          throw err;
        }
      }
    }
    // Log the user's owned guild IDs for debugging
    const userGuilds = (req.user.guilds || []).filter(g => g.owner).map(g => g.id);
    console.log('User-owned guilds:', userGuilds);
    const guilds = (req.user.guilds || [])
      .filter(g => g.owner)
      .map(g => ({
        ...g,
        botInGuild: botGuilds.includes(g.id)
      }));
    // Log the result for debugging
    console.log('Guilds with botInGuild:', guilds.map(g => ({ id: g.id, name: g.name, botInGuild: g.botInGuild })));
    res.json({ guilds });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bot guilds' });
  }
});

// Utility: Auth middleware
function ensureAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

// Redirect /dashboard.html to /servers for compatibility with login redirect
app.get('/dashboard.html', ensureAuth, (req, res) => {
  res.redirect('/servers');
});

// Modern servers page
app.get('/servers', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'servers.html'));
});

// User-friendly error page for rate limit during login
app.get('/login-rate-limit', (req, res) => {
  // Discord does not provide a specific retry-after, but we can use a smart guess (e.g., 60s, or longer if user has hit it multiple times)
  // Optionally, you could pass a retry-after header if you parse it from Discord, but here we use a default and store a cookie to increase wait if user hits it again
  let retrySeconds = 60;
  if (req.cookies && req.cookies.rl_wait) {
    // Exponential backoff: double the wait each time, max 10 min
    retrySeconds = Math.min(parseInt(req.cookies.rl_wait, 10) * 2, 600) || 60;
  }
  res.cookie('rl_wait', retrySeconds, { maxAge: retrySeconds * 1000, httpOnly: true });
  res.status(429).send(`
    <html>
      <head>
        <title>Rate Limited</title>
        <link rel="stylesheet" href="/styles/main.css">
        <link rel="stylesheet" href="/styles/rate-limit.css">
        <style>
          .retry-btn {
            display: inline-block;
            margin-top: 2em;
            padding: 0.7em 2em;
            background: linear-gradient(90deg, #7289da 0%, #99aab5 100%);
            color: #fff;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            font-size: 1em;
            border: none;
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(114,137,218,0.15);
            transition: background 0.2s;
          }
          .retry-btn:disabled {
            background: #888;
            cursor: not-allowed;
            opacity: 0.7;
          }
        </style>
      </head>
      <body>
        <div class="rate-limit-container">
          <div class="rate-limit-title">You are being rate limited by Discord</div>
          <div class="rate-limit-desc">
            Too many login attempts.<br>
            <b>Reason:</b> Discord limits how often you can log in or fetch server data in a short period to protect their service.<br><br>
            Please wait <b id='suggested-wait'></b> before trying again.<br><br>
            If this happens repeatedly, try closing extra tabs or browsers, or wait longer before retrying.
          </div>
          <a class="rate-limit-home" href="/">Return to Home</a>
          <button id="retryBtn" class="retry-btn" disabled>Try Again (<span id="timer">${retrySeconds}</span>s)</button>
        </div>
        <script>
          let seconds = ${retrySeconds};
          const timerSpan = document.getElementById('timer');
          const retryBtn = document.getElementById('retryBtn');
          const suggestedWait = document.getElementById('suggested-wait');
          function formatTime(s) {
            if (s < 60) return s + ' seconds';
            const m = Math.floor(s/60), sec = s%60;
            return m + ' minute' + (m>1?'s':'') + (sec ? (' ' + sec + 's') : '');
          }
          suggestedWait.textContent = formatTime(seconds);
          const interval = setInterval(() => {
            seconds--;
            timerSpan.textContent = seconds;
            suggestedWait.textContent = formatTime(seconds);
            if (seconds <= 0) {
              clearInterval(interval);
              retryBtn.disabled = false;
              retryBtn.textContent = 'Try Again';
              suggestedWait.textContent = 'now';
            }
          }, 1000);
          retryBtn.addEventListener('click', () => {
            retryBtn.disabled = true;
            retryBtn.textContent = 'Trying...';
            window.location.replace('/login');
          });
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Dashboard running on http://localhost:' + PORT);
});