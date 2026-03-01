export interface Post {
  id: number;
  title: string;
  content: string;
  author_id: number;
  created_at: Date;
}

export interface Comment {
  id: number;
  post_id: number;
  body: string;
  author_id: number;
  created_at: Date;
}

// TODO: Need a users table for authentication
// Currently posts reference author_id but there's no user table to join against

export const tables = {
  posts: `CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    author_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  comments: `CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    post_id INTEGER REFERENCES posts(id),
    body TEXT NOT NULL,
    author_id INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  )`,
  // TODO: users table needed — author_id columns have no FK constraint
};
