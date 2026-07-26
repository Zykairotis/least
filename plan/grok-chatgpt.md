• Proposed Plan                                                                                                                                                                                   
                                                                                                                                                                                                  
                                                                                                                                                                                                  
  # Dual-Client Tailscale Plan for ChatGPT + Grok                                                                                                                                                 
                                                                                                                                                                                                  
  Target file: plan/2026-06-20-dual-client-tailscale-chatgpt-grok.md                                                                                                                              
                                                                                                                                                                                                  
  ## Summary                                                                                                                                                                                      
                                                                                                                                                                                                  
  Add an explicit dual-client mode so one Least process on one Tailscale Funnel hostname can serve both ChatGPT and Grok at the same time without requiring two separate public URLs.             
                                                                                                                                                                                                  
  The current blocker is architectural:                                                                                                                                                           
                                                                                                                                                                                                  
  - the HTTP server mounts one MCP surface at /mcp                                                                                                                                                
  - auth is effectively global for that MCP surface                                                                                                                                               
  - LEAST_GROK_OAUTH=1 changes MCP tool security metadata from noauth to oauth2                                                                                                                   
  - ChatGPT Create App expects the No Auth flow for the current Least server shape, while Grok expects the OAuth wrapper flow                                                                     
                                                                                                                                                                                                  
  The new design keeps a single Tailscale host but splits the public MCP surfaces by path:                                                                                                        
                                                                                                                                                                                                  
  - ChatGPT surface: /mcp                                                                                                                                                                         
  - Grok surface: /mcp-grok                                                                                                                                                                       
                                                                                                                                                                                                  
  Chosen defaults for this plan:                                                                                                                                                                  
                                                                                                                                                                                                  
  - add explicit opt-in via --dual-client                                                                                                                                                         
  - preserve /mcp as the ChatGPT-compatible No Auth MCP path                                                                                                                                      
  - add /mcp-grok as the OAuth-backed Grok MCP path                                                                                                                                               
  - keep one shared Least bearer token for both surfaces                                                                                                                                          
  - keep single-surface legacy behavior unchanged unless dual mode is enabled                                                                                                                     
  - generalize the internal auth/surface model, but do not add RFC 7591 dynamic client registration in this change                                                                                
                                                                                                                                                                                                  
  ## Current State                                                                                                                                                                                
                                                                                                                                                                                                  
  Today, the relevant behavior is:                                                                                                                                                                
                                                                                                                                                                                                  
  - src/http.ts mounts one MCP route at /mcp                                                                                                                                                      
  - src/httpAuth.ts applies one global bearer/query-token check to the app after optional OAuth routes are mounted                                                                                
  - src/server.ts chooses one tool security scheme for the whole server:                                                                                                                          
      - noauth when Grok OAuth is off                                                                                                                                                             
      - oauth2 when Grok OAuth is on                                                                                                                                                              
                                                                                                                                                                                                  
  - src/oauthRoutes.ts serves one OAuth metadata set and one authorize/token flow, all scoped to the same host and implicitly the same MCP resource                                               
  - the launcher prints one public MCP URL and one optional Grok OAuth field set                                                                                                                  
                                                                                                                                                                                                  
  That is why one Tailscale hostname cannot currently satisfy both:                                                                                                                               
                                                                                                                                                                                                  
  - ChatGPT wants a stable No Auth MCP app URL                                                                                                                                                    
  - Grok wants an OAuth-backed MCP URL                                                                                                                                                            
  - the current server cannot advertise both at once for the same MCP surface                                                                                                                     
                                                                                                                                                                                                  
  ## Public Interface Changes                                                                                                                                                                     
                                                                                                                                                                                                  
  ### CLI and config                                                                                                                                                                              
                                                                                                                                                                                                  
  Add a new dual-surface opt-in:                                                                                                                                                                  
                                                                                                                                                                                                  
  - CLI flag: --dual-client                                                                                                                                                                       
  - env var: LEAST_DUAL_CLIENT=1                                                                                                                                                                  
  - saved settings/profile field: dualClient: true                                                                                                                                                
                                                                                                                                                                                                  
  Behavior rules:                                                                                                                                                                                 
                                                                                                                                                                                                  
  - --dual-client is allowed only when the HTTP MCP protocol is enabled                                                                                                                           
  - --dual-client requires a public HTTPS tunnel; reject --tunnel none                                                                                                                            
  - --dual-client implies Grok OAuth surface exposure; users do not need to separately reason about auth mode wiring                                                                              
  - --grok-oauth remains valid for legacy single-surface Grok mode                                                                                                                                
  - --dual-client + --grok-oauth is allowed and treated as dual mode, not as a conflict                                                                                                           
  - shared bearer token remains the only token model in this change                                                                                                                               
                                                                                                                                                                                                  
  ### Public URLs in dual mode                                                                                                                                                                    
                                                                                                                                                                                                  
  When --dual-client is enabled, the same public host exposes:                                                                                                                                    
                                                                                                                                                                                                  
  ChatGPT:                                                                                                                                                                                        
                                                                                                                                                                                                  
  - Server URL: https://<host>/mcp?least_token=<token>                                                                                                                                            
  - Authentication in ChatGPT Create App: No Auth                                                                                                                                                 
                                                                                                                                                                                                  
  Grok:                                                                                                                                                                                           
                                                                                                                                                                                                  
  - MCP URL: https://<host>/mcp-grok                                                                                                                                                              
  - Authorization Endpoint: https://<host>/oauth/authorize                                                                                                                                        
  - Token Endpoint: https://<host>/oauth/token                                                                                                                                                    
  - Client ID: least-grok                                                                                                                                                                         
  - Scope: mcp                                                                                                                                                                                    
                                                                                                                                                                                                  
  This keeps Grok’s current OAuth endpoint shape stable while changing only the Grok MCP path.                                                                                                    
                                                                                                                                                                                                  
  ### Backward compatibility                                                                                                                                                                      
                                                                                                                                                                                                  
  Single-surface modes stay unchanged:                                                                                                                                                            
                                                                                                                                                                                                  
  - current ChatGPT-only flow remains /mcp with No Auth                                                                                                                                           
  - current Grok-only flow remains /mcp plus OAuth if dual mode is not enabled                                                                                                                    
  - dual mode is the only mode that introduces /mcp-grok                                                                                                                                          
                                                                                                                                                                                                  
  ## Implementation Changes                                                                                                                                                                       
                                                                                                                                                                                                  
  ### 1. Introduce a surface model instead of one global auth mode                                                                                                                                
                                                                                                                                                                                                  
  Refactor the HTTP/MCP server wiring around explicit surfaces.                                                                                                                                   
                                                                                                                                                                                                  
  Define an internal surface type:                                                                                                                                                                
                                                                                                                                                                                                  
  - chatgpt                                                                                                                                                                                       
  - grok                                                                                                                                                                                          
                                                                                                                                                                                                  
  Define a per-surface auth mode:                                                                                                                                                                 
                                                                                                                                                                                                  
  - chatgpt => noauth                                                                                                                                                                             
  - grok => oauth2                                                                                                                                                                                
                                                                                                                                                                                                  
  Do not continue using config.grokOAuth as the single switch that determines MCP security metadata for the whole server. Instead:                                                                
                                                                                                                                                                                                  
  - keep config.grokOAuth as a legacy/launcher input                                                                                                                                              
  - derive one or more active surfaces from config                                                                                                                                                
  - generate MCP server instances with a surface-specific auth mode                                                                                                                               
                                                                                                                                                                                                  
  The cleanest internal API is:                                                                                                                                                                   
                                                                                                                                                                                                  
  - createLeastServer(config, options)                                                                                                                                                            
  - options.surface: "chatgpt" | "grok"                                                                                                                                                           
  - options.authMode: "noauth" | "oauth2"                                                                                                                                                         
                                                                                                                                                                                                  
  src/server.ts should stop inferring auth from config.grokOAuth directly. The tool security scheme must come from the passed surface/auth options.                                               
                                                                                                                                                                                                  
  ### 2. Mount separate MCP surfaces in the HTTP server                                                                                                                                           
                                                                                                                                                                                                  
  Refactor src/http.ts so it can mount more than one MCP route.                                                                                                                                   
                                                                                                                                                                                                  
  In dual mode:                                                                                                                                                                                   
                                                                                                                                                                                                  
  - mount ChatGPT surface at /mcp                                                                                                                                                                 
  - mount Grok surface at /mcp-grok                                                                                                                                                               
                                                                                                                                                                                                  
  Out of dual mode:                                                                                                                                                                               
                                                                                                                                                                                                  
  - preserve current behavior and mount only /mcp                                                                                                                                                 
                                                                                                                                                                                                  
  Implementation requirements:                                                                                                                                                                    
                                                                                                                                                                                                  
  - each surface gets its own McpServer instance created through createLeastServer                                                                                                                
  - each surface gets its own session transport map; do not share one session-id registry across both routes                                                                                      
  - GET, POST, and DELETE session handling must work independently for each surface                                                                                                               
  - healthz, onboarding page, and /v1 OpenAI-compatible routes remain host-level, not duplicated per surface                                                                                      
                                                                                                                                                                                                  
  Recommended structure in src/http.ts:                                                                                                                                                           
                                                                                                                                                                                                  
  - extract a helper like mountMcpSurface(app, path, serverFactory, authMiddlewareFactory, options)                                                                                               
  - keep one shared app and one shared config                                                                                                                                                     
  - mount route-scoped auth middleware directly on the MCP paths instead of using one app-wide auth gate                                                                                          
                                                                                                                                                                                                  
  ### 3. Split auth enforcement by route                                                                                                                                                          
                                                                                                                                                                                                  
  Refactor src/httpAuth.ts so auth decisions are route-scoped.                                                                                                                                    
                                                                                                                                                                                                  
  Current problem:                                                                                                                                                                                
                                                                                                                                                                                                  
  - one middleware protects everything after OAuth routes are mounted                                                                                                                             
  - WWW-Authenticate behavior is also global                                                                                                                                                      
                                                                                                                                                                                                  
  New structure:                                                                                                                                                                                  
                                                                                                                                                                                                  
  - createHttpAuthMiddleware(config, options)                                                                                                                                                     
  - options.surface: "chatgpt" | "grok"                                                                                                                                                           
  - options.oauthChallenge: boolean                                                                                                                                                               
                                                                                                                                                                                                  
  Behavior:                                                                                                                                                                                       
                                                                                                                                                                                                  
  - both surfaces still accept the shared Least token either as:                                                                                                                                  
      - Authorization: Bearer <token>                                                                                                                                                             
      - ?least_token=<token>                                                                                                                                                                      
                                                                                                                                                                                                  
  - ChatGPT surface /mcp:                                                                                                                                                                         
      - enforce token if configured                                                                                                                                                               
      - do not emit OAuth WWW-Authenticate metadata                                                                                                                                               
                                                                                                                                                                                                  
  - Grok surface /mcp-grok:                                                                                                                                                                       
      - enforce token if present                                                                                                                                                                  
      - if token missing/invalid and OAuth is enabled, emit:                                                                                                                                      
        WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"                                                                                                
                                                                                                                                                                                                  
  - OAuth endpoints themselves remain unauthenticated, as they are today                                                                                                                          
                                                                                                                                                                                                  
  Important compatibility detail:                                                                                                                                                                 
                                                                                                                                                                                                  
  - the Grok OAuth flow currently returns config.authToken as the access token                                                                                                                    
  - keep that behavior in this change so both surfaces share one bearer token model                                                                                                               
                                                                                                                                                                                                  
  ### 4. Keep OAuth metadata host-level but make it describe the Grok surface                                                                                                                     
                                                                                                                                                                                                  
  Refactor src/oauthRoutes.ts so the OAuth metadata explicitly targets the Grok MCP surface in dual mode.                                                                                         
                                                                                                                                                                                                  
  In dual mode:                                                                                                                                                                                   
                                                                                                                                                                                                  
  - /.well-known/oauth-protected-resource should describe the Grok resource, not the ChatGPT one                                                                                                  
  - resource should be https://<origin>/mcp-grok                                                                                                                                                  
  - resource_documentation can still point to /setup                                                                                                                                              
  - authorization server metadata can stay at:                                                                                                                                                    
      - /.well-known/oauth-authorization-server                                                                                                                                                   
      - /oauth/authorize                                                                                                                                                                          
      - /oauth/token                                                                                                                                                                              
                                                                                                                                                                                                  
  Out of dual mode:                                                                                                                                                                               
                                                                                                                                                                                                  
  - preserve today’s shape, where the protected resource is the legacy /mcp Grok flow                                                                                                             
                                                                                                                                                                                                  
  Keep the current fixed-client behavior externally:                                                                                                                                              
                                                                                                                                                                                                  
  - client_id must still match config.grokOAuthClientId                                                                                                                                           
  - PKCE S256 remains required                                                                                                                                                                    
  - returned access token remains the shared Least token                                                                                                                                          
  - no dynamic client registration is added                                                                                                                                                       
                                                                                                                                                                                                  
  Internal generalization to include:                                                                                                                                                             
                                                                                                                                                                                                  
  - compute the resource path from mode (/mcp vs /mcp-grok)                                                                                                                                       
  - remove hardcoded assumptions that the Grok resource path is always /mcp                                                                                                                       
                                                                                                                                                                                                  
  ### 5. Launcher and setup UX                                                                                                                                                                    
                                                                                                                                                                                                  
  Update scripts/least.mjs to expose dual mode cleanly.                                                                                                                                           
                                                                                                                                                                                                  
  Add:                                                                                                                                                                                            
                                                                                                                                                                                                  
  - --dual-client to usage()                                                                                                                                                                      
  - saved profile support in least setup, least settings set, least settings show, and least start                                                                                                
  - doctor output that explains which public paths will exist in dual mode                                                                                                                        
                                                                                                                                                                                                  
  Startup validation:                                                                                                                                                                             
                                                                                                                                                                                                  
  - reject --dual-client with --tunnel none                                                                                                                                                       
  - reject --dual-client if no HTTP token is available                                                                                                                                            
  - allow --dual-client with Tailscale Funnel, Cloudflare, Cloudflare named tunnel, and ngrok                                                                                                     
  - dual mode should not be Tailscale-only in code, even though Tailscale is the motivating workflow                                                                                              
                                                                                                                                                                                                  
  Tailscale-specific startup output in dual mode must print both surfaces explicitly:                                                                                                             
                                                                                                                                                                                                  
  - ChatGPT Server URL with tokenized /mcp                                                                                                                                                        
  - Grok MCP URL at /mcp-grok                                                                                                                                                                     
  - Grok authorize/token endpoints                                                                                                                                                                
                                                                                                                                                                                                  
  Recommended command example:                                                                                                                                                                    
                                                                                                                                                                                                  
  least tailscale \                                                                                                                                                                               
    --root /absolute/path/to/repo \                                                                                                                                                               
    --tool-mode full \                                                                                                                                                                            
    --bash full \                                                                                                                                                                                 
    --write workspace \                                                                                                                                                                           
    --dual-client \                                                                                                                                                                               
    --token keep-this-stable-token                                                                                                                                                                
                                                                                                                                                                                                  
  Windows example for docs:                                                                                                                                                                       
                                                                                                                                                                                                  
  least tailscale --root "X:\Zk-Tz" --tool-mode full --bash full --write workspace --dual-client --token "keep-this-stable-token"                                                                 
                                                                                                                                                                                                  
  ### 6. Onboarding page and docs                                                                                                                                                                 
                                                                                                                                                                                                  
  Update the HTTP onboarding HTML in src/http.ts and the Markdown docs to reflect dual mode.                                                                                                      
                                                                                                                                                                                                  
  In dual mode, /setup and startup output should show:                                                                                                                                            
                                                                                                                                                                                                  
  - ChatGPT:                                                                                                                                                                                      
      - Server URL                                                                                                                                                                                
      - No Auth                                                                                                                                                                                   
      - /mcp?least_token=...                                                                                                                                                                      
                                                                                                                                                                                                  
  - Grok:                                                                                                                                                                                         
      - MCP URL /mcp-grok                                                                                                                                                                         
      - /oauth/authorize                                                                                                                                                                          
      - /oauth/token                                                                                                                                                                              
      - least-grok                                                                                                                                                                                
      - mcp                                                                                                                                                                                       
                                                                                                                                                                                                  
  Docs to update:                                                                                                                                                                                 
                                                                                                                                                                                                  
  - README.md                                                                                                                                                                                     
  - DOMAIN_SETUP.md                                                                                                                                                                               
  - FAQ.md if it already discusses Grok/ChatGPT limitations together                                                                                                                              
  - CHANGELOG.md                                                                                                                                                                                  
                                                                                                                                                                                                  
  The docs should explicitly explain:                                                                                                                                                             
                                                                                                                                                                                                  
  - why one host previously failed                                                                                                                                                                
  - what dual mode changes                                                                                                                                                                        
  - that ChatGPT should use /mcp                                                                                                                                                                  
  - that Grok should use /mcp-grok                                                                                                                                                                
  - that both still point at the same local workspace and same Least token                                                                                                                        
  - that concurrent edits from both clients can conflict at the repo level                                                                                                                        
                                                                                                                                                                                                  
  ## Test Plan                                                                                                                                                                                    
                                                                                                                                                                                                  
  ### Unit/integration coverage                                                                                                                                                                   
                                                                                                                                                                                                  
  Add HTTP-level coverage for:                                                                                                                                                                    
                                                                                                                                                                                                  
  - /mcp tool descriptors advertise noauth in dual mode                                                                                                                                           
  - /mcp-grok tool descriptors advertise oauth2 in dual mode                                                                                                                                      
  - unauthorized /mcp returns plain 401 without OAuth challenge metadata                                                                                                                          
  - unauthorized /mcp-grok returns 401 with WWW-Authenticate resource metadata                                                                                                                    
  - /.well-known/oauth-protected-resource returns the dual-mode Grok resource path                                                                                                                
  - /oauth/token returns the shared Least token after a valid code flow                                                                                                                           
                                                                                                                                                                                                  
  ### Launcher/smoke coverage                                                                                                                                                                     
                                                                                                                                                                                                  
  Extend the smoke suite to cover:                                                                                                                                                                
                                                                                                                                                                                                  
  - CLI parsing of --dual-client                                                                                                                                                                  
  - settings round-trip for dualClient                                                                                                                                                            
  - doctor output mentions dual-client/public MCP paths                                                                                                                                           
  - Tailscale dual-mode startup prints both:                                                                                                                                                      
      - .../mcp?least_token=...                                                                                                                                                                   
      - .../mcp-grok                                                                                                                                                                              
                                                                                                                                                                                                  
  - Grok OAuth smoke path succeeds against /mcp-grok                                                                                                                                              
  - existing ChatGPT-compatible smoke path continues to succeed against /mcp                                                                                                                      
                                                                                                                                                                                                  
  Recommended new smoke script:                                                                                                                                                                   
                                                                                                                                                                                                  
  - scripts/dual-client-smoke.mjs                                                                                                                                                                 
                                                                                                                                                                                                  
  Recommended behavior in that script:                                                                                                                                                            
                                                                                                                                                                                                  
  - start Least with fake Tailscale and --dual-client                                                                                                                                             
  - verify the ts.net host becomes healthy                                                                                                                                                        
  - verify startup output contains both public paths                                                                                                                                              
  - hit /mcp initialize flow and confirm ChatGPT-style metadata                                                                                                                                   
  - hit /mcp-grok unauthenticated and confirm OAuth challenge                                                                                                                                     
  - complete Grok OAuth flow and confirm access token works on /mcp-grok                                                                                                                          
                                                                                                                                                                                                  
  ### Full repo verification                                                                                                                                                                      
                                                                                                                                                                                                  
  - npm run build
  - node scripts/grok-oauth-smoke.mjs
  - node scripts/http-smoke.mjs
  - node scripts/settings-smoke.mjs
  - node scripts/doctor-smoke.mjs
  - node scripts/tailscale-funnel-smoke.mjs
  - new dual-client smoke test
  - npm run smoke

  ## Acceptance Criteria

  The change is complete when all of the following are true:

  1. One Least process can run on one Tailscale Funnel hostname and expose both ChatGPT and Grok simultaneously.
  2. ChatGPT works on /mcp with No Auth and tokenized URL query auth.
  3. Grok works on /mcp-grok with the OAuth wrapper and shared Least bearer token.
  4. --dual-client is persisted through setup/settings/start flows.
  5. Existing single-surface ChatGPT behavior is unchanged when dual mode is off.
  6. Existing single-surface Grok behavior is unchanged when dual mode is off.
  7. Startup output and docs clearly show both public surfaces.
  8. Full smoke/build verification passes.

  ## Risks and Edge Cases

  - Two MCP surfaces in one process means transport/session handling must be isolated per route; sharing one map is unsafe and will couple unrelated sessions.
  - The OAuth protected-resource metadata must name the Grok MCP path in dual mode; if it still points to /mcp, the flow will remain ambiguous.
  - ChatGPT and Grok can now both edit the same workspace concurrently; this is expected behavior but must be documented as a workflow risk, not treated as a transport bug.
  - The onboarding page and terminal UX must avoid implying that /mcp is valid for both products in dual mode.
  - If the auth middleware remains app-global by mistake, ChatGPT will continue to receive OAuth-oriented headers and the original failure mode will persist.

  ## Assumptions

  - Shared Least token remains the only supported token model in this change.
  - /mcp remains the default ChatGPT MCP path in dual mode.
  - /mcp-grok is the only new Grok MCP path added in this change.
  - OAuth metadata endpoints remain root-level and describe the Grok surface in dual mode.
  - RFC 7591 dynamic client registration is out of scope.
  - Dual mode is implemented generically enough to work on any public HTTPS tunnel, but Tailscale Funnel remains the primary documented use case.