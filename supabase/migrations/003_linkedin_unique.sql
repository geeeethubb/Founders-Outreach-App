-- Prevent duplicate contacts for the same user + LinkedIn URL
-- Run once in Supabase SQL Editor

-- First remove any existing duplicates (keep the oldest one)
DELETE FROM contacts
WHERE id NOT IN (
  SELECT DISTINCT ON (user_id, linkedin_url) id
  FROM contacts
  WHERE linkedin_url IS NOT NULL
  ORDER BY user_id, linkedin_url, created_at ASC
);

-- Add unique constraint: one linkedin_url per user
CREATE UNIQUE INDEX IF NOT EXISTS contacts_user_linkedin_unique
  ON contacts (user_id, linkedin_url)
  WHERE linkedin_url IS NOT NULL;
