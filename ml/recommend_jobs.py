import sys
import json
import psycopg2
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# PostgreSQL connection
conn = psycopg2.connect(
    host="localhost",
    database="college",
    user="postgres",
    password="balaji125",
    port="5432"
)
cur = conn.cursor()

# 1️⃣ Get student ID from Node
if len(sys.argv) < 2:
    print(json.dumps({"error": "No student ID provided"}))
    sys.exit(1)

student_id = sys.argv[1]

# 2️⃣ Get student's latest resume skills
cur.execute("SELECT skills FROM resumes WHERE student_id = %s ORDER BY id DESC LIMIT 1", (student_id,))
student_skills_row = cur.fetchone()
if not student_skills_row:
    print(json.dumps({"error": "No resume found for this student"}))
    sys.exit(1)

student_skills = student_skills_row[0]

# 3️⃣ Get job postings
cur.execute("SELECT id, job_title, skills FROM job_postings")
jobs = cur.fetchall()
if not jobs:
    print(json.dumps({"error": "No job postings found"}))
    sys.exit(1)

job_ids = [job[0] for job in jobs]
job_titles = [job[1] for job in jobs]
job_skills = [job[2] if job[2] else "" for job in jobs]

# 4️⃣ Vectorize and compute similarity
vectorizer = TfidfVectorizer(tokenizer=lambda x: x.split(","))
all_skills = job_skills + [student_skills]
tfidf_matrix = vectorizer.fit_transform(all_skills)
similarities = cosine_similarity(tfidf_matrix[-1], tfidf_matrix[:-1]).flatten()

# 5️⃣ Sort and take top 5
top_indices = similarities.argsort()[::-1][:5]
recommendations = [
    {"id": job_ids[i], "title": job_titles[i], "match_score": round(float(similarities[i]), 2)}
    for i in top_indices
]

# 6️⃣ Output JSON
print(json.dumps(recommendations))

cur.close()
conn.close()
