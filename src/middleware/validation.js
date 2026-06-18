// src/middleware/validation.js
import { z } from 'zod';
import { NextResponse } from 'next/server';

// Schema for license verification request
export const verifyLicenseSchema = z.object({
  license_key: z.string().min(1),
  device_id: z.string().optional(),
  device_public_key: z.string().optional(),
  timestamp: z.string().optional(),
  signature: z.string().optional()
});

// Schema for prompt check request
export const promptCheckSchema = z.object({
  session_token: z.string().min(1),
  prompt: z.string().optional(),
  device_id: z.string().optional(),
  timestamp: z.string().optional(),
  signature: z.string().optional()
});

/**
 * Middleware helper to validate request body against a Zod schema.
 * Returns a NextResponse with 400 status if validation fails.
 */
export async function validate(schema, req) {
  try {
    const body = await req.json();
    schema.parse(body);
    // Return null to indicate success
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Invalid request payload';
    return NextResponse.json({ valid: false, message }, { status: 400, headers: corsHeaders() });
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-license-key, x-session-id, x-device-id'
  };
}
