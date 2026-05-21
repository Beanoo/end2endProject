# Conduit Module Map

## Monorepo Structure

```text
.
├── backend
│   ├── config
│   ├── controllers
│   ├── helper
│   ├── middleware
│   ├── migrations
│   ├── models
│   ├── routes
│   └── seeders
├── frontend
│   ├── public
│   └── src
│       ├── components
│       ├── context
│       ├── helpers
│       ├── hooks
│       ├── routes
│       └── services
├── package.json
└── vitest.config.js
```

## Backend Modules

### Entry

- `backend/index.js`

Responsibilities:

- Load environment variables.
- Create Express app.
- Configure CORS and JSON parsing.
- Initialize Sequelize connection.
- Register API routes.
- Register error handler.
- Start HTTP server.

Mounted routes:

```text
/api/users
/api/user
/api/articles
/api/profiles
/api/tags
```

### Domain Models

#### User

File:

- `backend/models/User.js`

Fields:

- `email`
- `username`
- `bio`
- `image`
- `password`

Associations:

- User has many Articles.
- User has many Comments.
- User belongs to many Articles through `Favorites`.
- User belongs to many Users through `Followers` as followers.
- User belongs to many Users through `Followers` as following.

Typical feature areas:

- Authentication
- Profile
- Follow/unfollow
- Favorites

#### Article

File:

- `backend/models/Article.js`

Fields:

- `slug`
- `title`
- `description`
- `body`

Associations:

- Article belongs to User as `author`.
- Article has many Comments.
- Article belongs to many Tags through `TagList`.
- Article belongs to many Users through `Favorites`.

Typical feature areas:

- Article list
- Article detail
- Article editor
- Feed
- Favorite/unfavorite
- Tags
- Comments

#### Comment

File:

- `backend/models/Comment.js`

Fields:

- `id`
- `body`

Associations:

- Comment belongs to Article.
- Comment belongs to User as `author`.

Typical feature areas:

- Article detail comments
- Comment creation
- Comment deletion

#### Tag

File:

- `backend/models/Tag.js`

Fields:

- `name`

Associations:

- Tag belongs to many Articles through `TagList`.

Typical feature areas:

- Popular tags
- Article tag list
- Tag-based filtering

## Backend Route Map

### Users and Auth

Files:

- `backend/routes/users.js`
- `backend/routes/user.js`
- `backend/controllers/users.js`
- `backend/controllers/user.js`

Routes:

```text
POST /api/users
POST /api/users/login
GET  /api/user
PUT  /api/user
```

### Articles

Files:

- `backend/routes/articles.js`
- `backend/controllers/articles.js`

Routes:

```text
GET    /api/articles
POST   /api/articles
GET    /api/articles/feed
GET    /api/articles/:slug
PUT    /api/articles/:slug
DELETE /api/articles/:slug
```

### Favorites

Files:

- `backend/routes/articles/favorites.js`
- `backend/controllers/favorites.js`

Routes:

```text
POST   /api/articles/:slug/favorite
DELETE /api/articles/:slug/favorite
```

### Comments

Files:

- `backend/routes/articles/comments.js`
- `backend/controllers/comments.js`

Routes:

```text
GET    /api/articles/:slug/comments
POST   /api/articles/:slug/comments
DELETE /api/articles/:slug/comments/:id
```

### Profiles

Files:

- `backend/routes/profiles.js`
- `backend/controllers/profiles.js`

Routes:

```text
GET    /api/profiles/:username
POST   /api/profiles/:username/follow
DELETE /api/profiles/:username/follow
```

### Tags

Files:

- `backend/routes/tags.js`

Routes:

```text
GET /api/tags
```

## Frontend Modules

### Entry and Routing

Files:

- `frontend/src/main.jsx`
- `frontend/src/App.jsx`

Responsibilities:

- Mount React app.
- Configure route outlet layout.
- Render navbar, page content, and footer.

### Pages

Route files:

- `frontend/src/routes/Home.jsx`
- `frontend/src/routes/HomeArticles.jsx`
- `frontend/src/routes/Article/Article.jsx`
- `frontend/src/routes/Article/CommentsSection.jsx`
- `frontend/src/routes/ArticleEditor.jsx`
- `frontend/src/routes/Login.jsx`
- `frontend/src/routes/SignUp.jsx`
- `frontend/src/routes/Settings.jsx`
- `frontend/src/routes/Profile/Profile.jsx`
- `frontend/src/routes/Profile/ProfileArticles.jsx`
- `frontend/src/routes/Profile/ProfileFavArticles.jsx`
- `frontend/src/routes/NotFound.jsx`

### API Service Layer

Files:

- `frontend/src/services/getArticle.js`
- `frontend/src/services/getArticles.js`
- `frontend/src/services/setArticle.js`
- `frontend/src/services/deleteArticle.js`
- `frontend/src/services/getComments.js`
- `frontend/src/services/postComment.js`
- `frontend/src/services/deleteComment.js`
- `frontend/src/services/getProfile.js`
- `frontend/src/services/getTags.js`
- `frontend/src/services/toggleFav.js`
- `frontend/src/services/toggleFollow.js`
- `frontend/src/services/getUser.js`
- `frontend/src/services/userLogin.js`
- `frontend/src/services/userLogout.js`
- `frontend/src/services/userSignUp.js`
- `frontend/src/services/userUpdate.js`

Responsibilities:

- Encapsulate HTTP calls to backend API.
- Provide stable integration points for frontend feature changes.

### Context

Files:

- `frontend/src/context/AuthContext.jsx`
- `frontend/src/context/FeedContext.jsx`

Responsibilities:

- Auth state and request headers.
- Feed state and filters.

### Important Components

Article-related:

- `ArticleMeta`
- `ArticlesButtons`
- `ArticleTags`
- `ArticleEditorForm`
- `ArticlesPreview`
- `ArticlesPagination`

Auth/user-related:

- `LoginForm`
- `SignUpForm`
- `SettingsForm`
- `Avatar`
- `AuthorInfo`

Social:

- `FavButton`
- `FollowButton`
- `CommentEditor`
- `CommentList`

Navigation/layout:

- `Navbar`
- `Footer`
- `FeedToggler`
- `PopularTags`
- `BannerContainer`

## Test Baseline

Current test files:

- `backend/helper/helpers.test.js`
- `frontend/src/helpers/dateFormatter.test.js`
- `frontend/src/helpers/errorHandler.test.js`

Current command:

```bash
npm run test
```

Current result:

```text
3 test files passed
12 tests passed
```

Coverage gap:

- No API integration tests yet.
- No E2E tests yet.
- No controller tests yet.
- No model tests yet.
- No route-level contract tests yet.

## First Demo Requirement Impact Map

Demo requirement:

```text
作为登录用户，我希望在文章详情页看到文章字数统计，以便判断阅读成本。
```

Likely backend files:

- `backend/models/Article.js`
- `backend/controllers/articles.js`
- `backend/routes/articles.js`

Likely frontend files:

- `frontend/src/routes/Article/Article.jsx`
- `frontend/src/services/getArticle.js`
- `frontend/src/components/ArticleMeta/ArticleMeta.jsx`

Likely tests:

- Add API test for article detail response.
- Add frontend unit or component test for article detail rendering.
- Add E2E test after Playwright is introduced.

