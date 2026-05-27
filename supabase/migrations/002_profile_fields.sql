-- Add personal context fields to profiles
-- Run this in Supabase SQL Editor

alter table profiles
  add column if not exists linkedin_bio_text  text,
  add column if not exists resume_text        text,
  add column if not exists portfolio_url      text,
  add column if not exists personal_context   text,
  add column if not exists graduation_year    text,
  add column if not exists major              text;
