import { NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req) {
  try {
    const { password } = await req.json().catch(() => ({}));
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (!password) {
      return NextResponse.json({ success: false, message: 'Password is required' }, { status: 400 });
    }

    if (password === adminPassword) {
      // Create a simple token based on password + date hash
      const hash = crypto
        .createHash('sha256')
        .update(password + 'LovablePowerkitsSalt')
        .digest('hex');

      return NextResponse.json({
        success: true,
        token: `adm_${hash}`,
      });
    }

    return NextResponse.json({ success: false, message: 'Incorrect password' }, { status: 401 });
  } catch (error) {
    console.error('Auth API error:', error);
    return NextResponse.json({ success: false, message: 'Internal Server Error' }, { status: 500 });
  }
}
